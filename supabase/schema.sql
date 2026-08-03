-- Sitting Pretty production schema (Supabase Postgres)
-- Contract: /API.md. Mock parity: server/ demo keeps the same shapes.
-- Run on a fresh Supabase project (SQL Editor paste, or as a migration, see
-- RUNBOOK.md step 2). This file is IDEMPOTENT: re-running it on a live
-- database is safe and is how you apply the sign-in changes to a project
-- that was created before them.
--
-- All writes in production go through the edge functions using the service
-- role key; RLS gives clients read access to their own rows only.

create extension if not exists pgcrypto;
create extension if not exists btree_gist; -- for the bookings_overlap exclusion constraint

-- ---------------------------------------------------------------------------
-- clients: one row per auth user.
--
-- Supabase Auth owns credentials; this table owns the salon-side profile.
-- Three ways in, all landing on the same clients row (API.md "Auth"):
--   password  supabase.auth.signUp / signInWithPassword
--   google    supabase.auth.signInWithOAuth({ provider: "google" })
--   code      supabase.auth.signInWithOtp / verifyOtp (6-digit email code)
--
-- has_password   true when Supabase Auth holds a password for this user.
--                Read by the UI to decide whether to offer the password box
--                or send someone through the code flow to set one.
-- auth_provider  how she can get in, most convenient first:
--                'google'   a Google identity is linked (the Google button
--                           always works for her, with or without a password)
--                'password' no Google identity, but a password is set
--                'code'     neither, email code only
--                Both columns are DERIVED from auth.users + auth.identities
--                by sp_sync_client() below and kept fresh by triggers. Never
--                write them by hand.
--
-- Admin = clients.is_admin, checked in the edge functions (_shared/auth.ts
-- requireAdmin) with the service role key. There is no separate admin table.
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  name text,
  phone text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.clients
  add column if not exists has_password boolean not null default false;
alter table public.clients
  add column if not exists auth_provider text not null default 'code';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_auth_provider_check'
  ) then
    alter table public.clients add constraint clients_auth_provider_check
      check (auth_provider in ('password', 'google', 'code'));
  end if;
end $$;

-- Same email, different letter case, must never become two clients.
-- auth.users already enforces one account per email; this is the local guard.
create unique index if not exists clients_email_lower_idx
  on public.clients (lower(email));

-- ---------------------------------------------------------------------------
-- bookings: one row per appointment. Client fields are snapshotted at booking
-- time so the dashboard still reads right if a client edits their profile.
-- Shape mirrors the Booking object in API.md.
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  client_name text,
  client_email text not null,
  client_phone text,
  service_id text not null,
  service_name text not null,
  price text not null,
  deposit_cents integer check (deposit_cents is null or deposit_cents > 0),
  date date not null,
  time text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min integer not null check (duration_min > 0),
  status text not null default 'awaiting_deposit'
    check (status in ('awaiting_deposit', 'request', 'confirmed', 'completed', 'canceled')),
  notes text not null default '',
  canceled_by text check (canceled_by in ('client', 'admin')),
  stripe_session_id text,
  deposit_paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- bookings_overlap: the DATABASE-LEVEL "one client at a time" guarantee.
-- bookings.ts checks availability before inserting, but two truly
-- simultaneous requests can both pass that check. This exclusion constraint
-- makes Postgres itself reject any overlap of [start, start + duration_min)
-- minutes per date among non-canceled bookings. The losing insert fails with
-- SQLSTATE 23P01, which bookings.ts turns into a friendly 409 ("that time
-- was just taken") so the client simply picks another slot.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_overlap') then
    alter table public.bookings add constraint bookings_overlap
      exclude using gist (
        date with =,
        (int4range(
          split_part("time", ':', 1)::int * 60 + split_part("time", ':', 2)::int,
          split_part("time", ':', 1)::int * 60 + split_part("time", ':', 2)::int + duration_min
        )) with &&
      ) where (status <> 'canceled');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- blocked_days: whole days Ebony closes from the dashboard (sick, holiday).
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_days (
  date date primary key,
  reason text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- broadcasts: master messages sent to every client from the dashboard.
-- ---------------------------------------------------------------------------
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  message text not null,
  sent_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- notifications_log: every rendered notification, whether it was actually
-- delivered or only logged (no provider keys configured). This is the
-- production replacement for the demo outbox.
-- status: sent = provider accepted, failed = provider rejected,
-- logged = rendered but not sent (missing provider key or phone number).
-- ---------------------------------------------------------------------------
create table if not exists public.notifications_log (
  id bigint generated always as identity primary key,
  event text not null,
  channel text not null check (channel in ('email', 'sms')),
  recipient text,
  subject text,
  body text not null,
  status text not null check (status in ('sent', 'failed', 'logged')),
  provider_id text,
  error text,
  booking_id uuid references public.bookings (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ON UPDATE CASCADE on the client_id foreign keys.
-- Needed by the account-adoption branch of sp_sync_client(): in the rare case
-- where a clients row already holds an email under a retired auth user id,
-- the row is re-pointed at the new auth user instead of a duplicate account
-- being created, and her bookings follow it.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'bookings_client_id_fkey' and confupdtype <> 'c'
  ) then
    alter table public.bookings drop constraint bookings_client_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_client_id_fkey') then
    alter table public.bookings add constraint bookings_client_id_fkey
      foreign key (client_id) references public.clients (id)
      on update cascade on delete cascade;
  end if;

  if exists (
    select 1 from pg_constraint
     where conname = 'notifications_log_client_id_fkey' and confupdtype <> 'c'
  ) then
    alter table public.notifications_log drop constraint notifications_log_client_id_fkey;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'notifications_log_client_id_fkey'
  ) then
    alter table public.notifications_log add constraint notifications_log_client_id_fkey
      foreign key (client_id) references public.clients (id)
      on update cascade on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sp_sync_client: the single place that turns an auth user into a clients row.
--
-- Called from the auth.users triggers below (so the row exists the moment
-- someone signs up, whichever way they signed up) and from the edge function
-- (_shared/auth.ts) as a self-heal if the row is ever missing or stale.
--
-- What it does:
--  1. reads the auth user, its linked identities, and whether a password is set
--  2. derives has_password and auth_provider (see the clients comment above)
--  3. inserts or refreshes the clients row, filling name and phone from the
--     sign-up metadata ONLY when the profile does not already have them, so a
--     Google display name never overwrites what she typed in her profile
--  4. LINKING: if a clients row already holds this email under a different
--     auth user id, that row is adopted (re-pointed at this user, bookings
--     cascading with it) instead of a second account being created. Adoption
--     only happens when this user's email is confirmed, because adopting on
--     an unconfirmed email would hand one person another person's bookings.
--     Returns null instead of guessing when the email is unconfirmed.
--
-- is_admin is never touched here. Only a human running SQL grants admin.
-- ---------------------------------------------------------------------------
create or replace function public.sp_sync_client(uid uuid)
returns public.clients
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  u auth.users%rowtype;
  providers text[];
  has_pw boolean;
  provider text;
  meta_name text;
  meta_phone text;
  other_id uuid;
  result public.clients%rowtype;
begin
  select * into u from auth.users where id = uid;
  if not found or u.email is null or btrim(u.email) = '' then
    return null;
  end if;

  -- Linked identities are the source of truth; app_metadata is the fallback
  -- for older rows. app_metadata is server-controlled, never user-editable.
  providers := coalesce(
    (select array_agg(i.provider) from auth.identities i where i.user_id = u.id),
    array[]::text[]
  );
  providers := providers || coalesce(
    (select array_agg(v) from jsonb_array_elements_text(
       case when jsonb_typeof(u.raw_app_meta_data -> 'providers') = 'array'
            then u.raw_app_meta_data -> 'providers'
            else '[]'::jsonb end) v),
    array[]::text[]
  );
  if u.raw_app_meta_data ->> 'provider' is not null then
    providers := providers || (u.raw_app_meta_data ->> 'provider');
  end if;

  has_pw := nullif(btrim(coalesce(u.encrypted_password, '')), '') is not null;

  provider := case
    when 'google' = any (providers) then 'google'
    when has_pw then 'password'
    else 'code'
  end;

  meta_name := nullif(btrim(coalesce(
    u.raw_user_meta_data ->> 'name',
    u.raw_user_meta_data ->> 'full_name',
    '')), '');
  meta_phone := nullif(btrim(coalesce(
    u.raw_user_meta_data ->> 'phone',
    '')), '');

  -- Account linking safety net (see header note 4).
  select c.id into other_id
    from public.clients c
   where lower(c.email) = lower(u.email)
     and c.id <> u.id
   limit 1;

  if other_id is not null then
    if u.email_confirmed_at is null then
      return null;
    end if;
    update public.clients set id = u.id where id = other_id;
  end if;

  insert into public.clients as c (id, email, name, phone, has_password, auth_provider)
  values (u.id, lower(u.email), meta_name, meta_phone, has_pw, provider)
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(nullif(btrim(c.name), ''), excluded.name),
        phone = coalesce(nullif(btrim(c.phone), ''), excluded.phone),
        has_password = excluded.has_password,
        auth_provider = excluded.auth_provider
  returning * into result;

  return result;
end;
$$;

-- Trigger wrapper. Any failure in here is logged and swallowed on purpose:
-- a profile problem must never block someone from signing in. The edge
-- function repairs the row on the next request.
create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  perform public.sp_sync_client(new.id);
  return new;
exception when others then
  raise warning 'sitting pretty: client sync failed for % (%)', new.id, sqlerrm;
  return new;
end;
$$;

-- Replaced by handle_auth_user_change (which also handles updates).
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_change();

-- Keeps has_password, auth_provider, and email fresh when someone adds a
-- password, links Google to an account they already had, confirms their
-- email, or changes their address. The when clause skips the update that
-- fires on every single sign-in (last_sign_in_at).
drop trigger if exists on_auth_user_updated on auth.users;

create trigger on_auth_user_updated
  after update on auth.users
  for each row
  when (
    old.email is distinct from new.email
    or old.email_confirmed_at is distinct from new.email_confirmed_at
    or old.encrypted_password is distinct from new.encrypted_password
    or old.raw_app_meta_data is distinct from new.raw_app_meta_data
    or old.raw_user_meta_data is distinct from new.raw_user_meta_data
  )
  execute function public.handle_auth_user_change();

-- Backfill: recompute every existing clients row. Safe to run any number of
-- times, and it is what upgrades a database created before password/Google.
do $$
declare r record;
begin
  for r in select id from public.clients loop
    perform public.sp_sync_client(r.id);
  end loop;
end $$;

-- Grant Ke'Ebonie admin AFTER her first sign-in (RUNBOOK step 2).
-- PLACEHOLDER EMAIL: her real email is still unconfirmed. Replace before running.
-- update public.clients set is_admin = true where email = 'ebony@demo.local';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists bookings_date_status_idx on public.bookings (date, status);
create index if not exists bookings_client_created_idx on public.bookings (client_id, created_at desc);
create index if not exists bookings_stripe_session_idx on public.bookings (stripe_session_id);
create index if not exists notifications_log_booking_idx on public.notifications_log (booking_id);
create index if not exists notifications_log_created_idx on public.notifications_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Function privileges
-- Postgres grants EXECUTE to PUBLIC on every new function, which would make
-- these security-definer functions callable by anon and authenticated through
-- the Data API. Lock them to the service role (the edge functions) only.
-- The triggers still fire: trigger privileges are checked when the trigger is
-- created, not every time it runs.
-- ---------------------------------------------------------------------------
revoke all on function public.sp_sync_client(uuid) from public, anon, authenticated;
revoke all on function public.handle_auth_user_change() from public, anon, authenticated;
grant execute on function public.sp_sync_client(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Clients read their own rows. All writes (and every admin read) go through
-- the edge functions with the service role key, which bypasses RLS; admin is
-- authorized there via clients.is_admin.
--
-- No insert, update, or delete policies on purpose:
--  - profile edits go through POST /api/me so a client can never flip
--    is_admin, and can never fake has_password or auth_provider
--  - the clients row is created by the auth trigger, not by the browser
-- No anon policies on purpose: nobody signed out can probe whether an email
-- has an account here.
-- ---------------------------------------------------------------------------
alter table public.clients enable row level security;
alter table public.bookings enable row level security;
alter table public.blocked_days enable row level security;
alter table public.broadcasts enable row level security;
alter table public.notifications_log enable row level security;

drop policy if exists clients_select_own on public.clients;
create policy clients_select_own on public.clients
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists bookings_select_own on public.bookings;
create policy bookings_select_own on public.bookings
  for select to authenticated using ((select auth.uid()) = client_id);

-- blocked_days, broadcasts, notifications_log: no client policies at all.
-- Only the service role reads or writes them.
