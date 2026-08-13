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

-- ---------------------------------------------------------------------------
-- Deposit + balance money model (parity with server/server.mjs).
--
-- paid_cents      every dollar that has landed for this appointment: the
--                 deposit, an online balance payment, and anything Ebony
--                 collected in person. Only ever added to.
-- paid_in_full    true once paid_cents covers the price, or the moment Ebony
--                 records that she settled up with the client herself.
-- paid_in_person  she took the rest in the chair (cash, Zelle, her card
--                 reader), so the dashboard can say so.
-- balance_session_id  the Stripe Checkout session for the balance, kept apart
--                 from stripe_session_id (the deposit) so the webhook can tell
--                 a replay of a session it already applied from a second,
--                 genuinely duplicate payment.
--
-- total and balance are NOT stored. They are derived from the price string in
-- _shared/money.ts, so they can never drift from the payments above. A price
-- carrying a plus ("$50+") has no fixed total and is settled in person.
-- ---------------------------------------------------------------------------
alter table public.bookings
  add column if not exists paid_cents integer not null default 0;
alter table public.bookings
  add column if not exists paid_in_full boolean not null default false;
alter table public.bookings
  add column if not exists paid_in_person boolean not null default false;
alter table public.bookings
  add column if not exists balance_session_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_paid_cents_check'
  ) then
    alter table public.bookings add constraint bookings_paid_cents_check
      check (paid_cents >= 0);
  end if;
end $$;

-- One-time backfill, safe to re-run. A booking confirmed before these columns
-- existed already took its deposit; without this it would look unpaid and the
-- client would be asked for the full price a second time.
update public.bookings
   set paid_cents = deposit_cents
 where deposit_paid_at is not null
   and deposit_cents is not null
   and paid_cents = 0;

-- Same idea for the services that charge the whole price up front: once
-- paid_cents covers a fixed price, nothing is owed.
update public.bookings
   set paid_in_full = true
 where paid_in_full = false
   and price !~ '\+'
   and price ~ '\d'
   and paid_cents > 0
   -- numeric, not int: a price string can never overflow it, so this cannot
   -- fail on odd data. Same first-digit-run rule as totalCentsFor().
   and paid_cents >= (substring(price from '\d+')::numeric * 100);

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
-- holds: a slot reserved for a few minutes while a client pays her deposit.
--
-- THE DEPOSIT IS WHAT BOOKS THE SPOT. No money, no appointment.
--
-- A service with a published deposit does NOT create a booking when someone
-- picks a time. It creates a hold: the slot is reserved for HOLD_MINUTES (15,
-- API.md) while she completes Stripe Checkout, nobody else can take it in the
-- meantime, and it becomes a real appointment only when the deposit clears
-- (sp_book_hold below). If she walks away from checkout the hold expires and
-- the time is free again within minutes, instead of an unpaid appointment
-- sitting on a Saturday for a whole day.
--
-- Shape mirrors the `hold` object in API.md. Client fields are NOT snapshotted
-- here the way they are on bookings: a hold lives for minutes, and the booking
-- it turns into takes its snapshot then.
-- ---------------------------------------------------------------------------
create table if not exists public.holds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id)
    on update cascade on delete cascade,
  service_id text not null,
  service_name text not null,
  price text not null,
  deposit_cents integer not null check (deposit_cents > 0),
  date date not null,
  time text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min integer not null check (duration_min > 0),
  notes text not null default '',
  stripe_session_id text,
  created_at timestamptz not null default now(),
  -- Defaulted so a row can never land without an expiry, whatever inserts it.
  -- The API sets it explicitly from HOLD_MINUTES.
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  -- A hold blocks the slot exactly like a booking does, so an unlimited
  -- refresh would let one person squat a Saturday for free. The contract
  -- allows one extension while she is still on the checkout page.
  refresh_count integer not null default 0
);

-- holds_overlap: two people cannot hold the same time.
--
-- No `where expires_at > now()` clause: an index predicate has to be
-- IMMUTABLE and now() is not. So this covers every row, and expired rows are
-- removed before a new claim is checked (sp_slot_guard below, plus the sweeps
-- in the edge function and the pg_cron job in RUNBOOK step 6).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'holds_overlap') then
    alter table public.holds add constraint holds_overlap
      exclude using gist (
        date with =,
        (int4range(
          split_part("time", ':', 1)::int * 60 + split_part("time", ':', 2)::int,
          split_part("time", ':', 1)::int * 60 + split_part("time", ':', 2)::int + duration_min
        )) with &&
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sp_slot_guard: the cross-table half of "one client at a time".
--
-- bookings_overlap stops two BOOKINGS colliding and holds_overlap stops two
-- HOLDS colliding, but an EXCLUDE constraint cannot span two tables, and a
-- hold must block a booking exactly as hard as another booking does. This
-- trigger is that guarantee. It runs on both tables and, in this order:
--
--  1. takes a transaction advisory lock keyed on the calendar date. Without
--     it, two concurrent transactions could each look at the other table, see
--     nothing (the other row is not committed yet), and both commit. The lock
--     serializes claims per DAY, so it costs nothing in a one-chair salon.
--  2. deletes holds on that date that have already run out, so an abandoned
--     checkout can never keep a slot locked.
--  3. rejects the row when it overlaps a live claim in the OTHER table,
--     raising SQLSTATE 23P01 (exclusion_violation) exactly like the two
--     EXCLUDE constraints, so the edge function's existing "that time was
--     just taken" 409 covers this case with no extra branch.
-- ---------------------------------------------------------------------------
create or replace function public.sp_slot_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_start int;
  new_end int;
begin
  perform pg_advisory_xact_lock(hashtext('sitting-pretty-slot:' || new.date::text));

  -- Same date only: the advisory lock above already covers this date, so two
  -- sweeps can never fight over the same rows in a different order.
  delete from public.holds as expired
   where expired.date = new.date and expired.expires_at <= now();

  new_start := split_part(new.time, ':', 1)::int * 60 + split_part(new.time, ':', 2)::int;
  new_end := new_start + new.duration_min;

  if tg_table_name = 'holds' then
    perform 1
       from public.bookings b
      where b.date = new.date
        and b.status <> 'canceled'
        and new_start < split_part(b.time, ':', 1)::int * 60
                        + split_part(b.time, ':', 2)::int + b.duration_min
        and split_part(b.time, ':', 1)::int * 60
            + split_part(b.time, ':', 2)::int < new_end
      limit 1;
    if found then
      raise exception 'that time is already booked'
        using errcode = 'exclusion_violation';
    end if;
  else
    perform 1
       from public.holds h
      where h.date = new.date
        and h.expires_at > now()
        and new_start < split_part(h.time, ':', 1)::int * 60
                        + split_part(h.time, ':', 2)::int + h.duration_min
        and split_part(h.time, ':', 1)::int * 60
            + split_part(h.time, ':', 2)::int < new_end
      limit 1;
    if found then
      raise exception 'that time is being held by someone paying for it'
        using errcode = 'exclusion_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists holds_slot_guard on public.holds;
create trigger holds_slot_guard
  before insert on public.holds
  for each row execute function public.sp_slot_guard();

-- Only fires when a booking actually claims time: a new row, a move, or a
-- status change back into the calendar. Recording a payment does not re-check
-- anything. A canceled row claims nothing, so it is skipped.
drop trigger if exists bookings_slot_guard on public.bookings;
create trigger bookings_slot_guard
  before insert or update of "date", "time", duration_min, status on public.bookings
  for each row
  when (new.status <> 'canceled')
  execute function public.sp_slot_guard();

-- ---------------------------------------------------------------------------
-- sp_book_hold: the deposit landed, so this time is really hers now.
--
-- Deleting the hold and inserting the appointment happen in ONE transaction,
-- which matters twice over: the new booking never collides with the hold it
-- came from, and no third party can slip into the slot in between.
--
-- Returns null when the hold is gone or has already run out. The caller
-- (functions/api/stripe-webhook.ts) treats that as money that landed on
-- nothing: no appointment is invented, and Ebony is told to refund it.
--
-- p_paid_in_full comes from the caller so the price rules live in exactly one
-- place (_shared/money.ts), the same place the rest of the money model lives.
-- ---------------------------------------------------------------------------
create or replace function public.sp_book_hold(
  p_hold_id uuid,
  p_session_id text,
  p_amount_cents integer,
  p_paid_in_full boolean
)
returns public.bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d date;
  h public.holds%rowtype;
  c public.clients%rowtype;
  b public.bookings%rowtype;
begin
  -- Take the day's slot lock before touching anything, the same lock and the
  -- same order sp_slot_guard uses, so a booking being created here and a hold
  -- being created elsewhere can never wait on each other.
  select holds.date into d from public.holds where holds.id = p_hold_id;
  if not found then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('sitting-pretty-slot:' || d::text));

  -- Only a hold that is still alive becomes an appointment. One that ran out
  -- is left where it is for the caller to treat as money needing a refund.
  delete from public.holds
   where id = p_hold_id
     and expires_at > now()
  returning * into h;
  if not found then
    return null;
  end if;

  select * into c from public.clients where id = h.client_id;

  insert into public.bookings (
    client_id, client_name, client_email, client_phone,
    service_id, service_name, price, deposit_cents,
    date, time, duration_min, status, notes,
    stripe_session_id, deposit_paid_at, paid_cents, paid_in_full, created_at
  ) values (
    h.client_id, c.name, c.email, c.phone,
    h.service_id, h.service_name, h.price, h.deposit_cents,
    h.date, h.time, h.duration_min, 'confirmed', h.notes,
    coalesce(p_session_id, h.stripe_session_id), now(),
    coalesce(p_amount_cents, h.deposit_cents), coalesce(p_paid_in_full, false),
    h.created_at
  )
  returning * into b;

  return b;
end;
$$;

-- ---------------------------------------------------------------------------
-- blocked_days: whole days Ebony closes from the dashboard (sick, holiday).
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_days (
  date date primary key,
  reason text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- hours: her working week, one row per weekday. HOURS ARE DATA, NOT CODE.
--
-- This is the single source of truth read by the availability engine
-- (functions/api/bookings.ts), her dashboard, and the hours table on the
-- public site, so the site can never advertise hours she does not work.
--
-- weekday  0 = Sunday .. 6 = Saturday (matches JavaScript getUTCDay()).
-- closed   true = she does not work that day at all; open/close are null.
-- open,
-- close    "HH:MM" 24h, on the half hour, open strictly before close.
--
-- The check constraints below are the same rules PUT /api/admin/hours
-- enforces, so a bad row cannot get in even from a SQL console.
-- ---------------------------------------------------------------------------
create table if not exists public.hours (
  weekday smallint primary key check (weekday between 0 and 6),
  closed boolean not null default false,
  open text,
  close text,
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hours_open_format') then
    alter table public.hours add constraint hours_open_format
      check (open is null or open ~ '^([01][0-9]|2[0-3]):(00|30)$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hours_close_format') then
    alter table public.hours add constraint hours_close_format
      check (close is null or close ~ '^([01][0-9]|2[0-3]):(00|30)$');
  end if;
  -- A closed day carries no times; an open day carries both, in order.
  -- String comparison is safe because both are zero-padded HH:MM.
  if not exists (select 1 from pg_constraint where conname = 'hours_shape') then
    alter table public.hours add constraint hours_shape
      check (
        (closed and open is null and close is null)
        or (not closed and open is not null and close is not null and open < close)
      );
  end if;
end $$;

-- Her real current hours, from StyleSeat. These are the DEFAULT of an
-- editable record, not hardcoded logic: `do nothing` means re-running this
-- file never overwrites a change she made in her dashboard, and it restores
-- any weekday row that somehow went missing.
insert into public.hours (weekday, closed, open, close) values
  (0, true,  null,    null),
  (1, false, '09:00', '20:00'),
  (2, false, '09:00', '20:00'),
  (3, false, '09:00', '20:00'),
  (4, false, '09:00', '20:00'),
  (5, false, '09:00', '20:00'),
  (6, false, '09:00', '18:00')
on conflict (weekday) do nothing;

-- ---------------------------------------------------------------------------
-- broadcasts: master messages sent to every client from the dashboard.
-- image_url is the flyer she attached, already uploaded to Storage (see the
-- flyers bucket below). Null when she sent words only.
-- ---------------------------------------------------------------------------
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  message text not null,
  sent_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.broadcasts
  add column if not exists image_url text;

-- ---------------------------------------------------------------------------
-- flyers: the Storage bucket her broadcast flyers land in.
--
-- Public on purpose. The image has to load inside an email and on whatever
-- phone opens it, and signed URLs expire, which would leave a broken picture
-- in a message she already sent. Nothing private is ever put here: it holds
-- marketing flyers she is deliberately sending to every client.
--
-- Uploads happen in the edge function with the service role key AFTER
-- requireAdmin, so only she can put a file here. There is no browser upload
-- path and no policy granting one.
--
-- Guarded so this file still runs on a plain Postgres without the storage
-- schema (a local psql, a test database).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('flyers', 'flyers', true)
    on conflict (id) do update set public = true;

    -- Anyone can read a flyer (that is the point of sending it). No insert,
    -- update, or delete policy: the only writer is the service role.
    --
    -- Belt and braces, not the mechanism: a public bucket already serves
    -- reads through /storage/v1/object/public/. Some projects do not let SQL
    -- run here own storage.objects, and that must never stop the rest of
    -- this file from applying.
    begin
      drop policy if exists flyers_public_read on storage.objects;
      create policy flyers_public_read on storage.objects
        for select to anon, authenticated using (bucket_id = 'flyers');
    exception when insufficient_privilege then
      raise notice 'sitting pretty: skipped the flyers read policy (not the owner of storage.objects). The public bucket still serves flyers.';
    end;
  end if;
end $$;

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
     where conname = 'holds_client_id_fkey' and confupdtype <> 'c'
  ) then
    alter table public.holds drop constraint holds_client_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'holds_client_id_fkey') then
    alter table public.holds add constraint holds_client_id_fkey
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
create index if not exists bookings_balance_session_idx on public.bookings (balance_session_id);
-- Added after holds shipped: an existing table needs the column too.
alter table public.holds
  add column if not exists refresh_count integer not null default 0;

create index if not exists holds_date_idx on public.holds (date);
create index if not exists holds_expires_idx on public.holds (expires_at);
create index if not exists holds_client_idx on public.holds (client_id, created_at desc);
create index if not exists holds_stripe_session_idx on public.holds (stripe_session_id);
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
revoke all on function public.sp_slot_guard() from public, anon, authenticated;
revoke all on function public.sp_book_hold(uuid, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.sp_sync_client(uuid) to service_role;
-- Turning a paid hold into an appointment is a service-role move only: it is
-- called by the Stripe webhook after the signature verifies, never by a
-- browser.
grant execute on function public.sp_book_hold(uuid, text, integer, boolean) to service_role;

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
--
-- hours is the one exception: it is published information. Anyone can read
-- it (the public site prints it), and NOBODY can write it through the Data
-- API, not even her, because there is no insert/update/delete policy. Her
-- edits go through PUT /api/admin/hours, which checks is_admin and validates
-- the whole week before writing with the service role key.
-- ---------------------------------------------------------------------------
alter table public.clients enable row level security;
alter table public.bookings enable row level security;
alter table public.holds enable row level security;
alter table public.blocked_days enable row level security;
alter table public.broadcasts enable row level security;
alter table public.notifications_log enable row level security;
alter table public.hours enable row level security;

drop policy if exists clients_select_own on public.clients;
create policy clients_select_own on public.clients
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists bookings_select_own on public.bookings;
create policy bookings_select_own on public.bookings
  for select to authenticated using ((select auth.uid()) = client_id);

-- A client can see the time she is holding right now, and nobody else's. No
-- insert, update, or delete policy: holds are created, extended, and cleared
-- by the edge functions with the service role key, so a browser can never
-- reserve a Saturday for itself or push its own expiry out.
drop policy if exists holds_select_own on public.holds;
create policy holds_select_own on public.holds
  for select to authenticated using ((select auth.uid()) = client_id);

drop policy if exists hours_public_read on public.hours;
create policy hours_public_read on public.hours
  for select to anon, authenticated using (true);

-- blocked_days, broadcasts, notifications_log: no client policies at all.
-- Only the service role reads or writes them.

-- ---------------------------------------------------------------------------
-- leads: people who are not clients yet. The popup on the public site feeds
-- this table so Ebony has a marketing list beyond the people who already
-- booked. Written by POST /api/leads (edge function, service role) after
-- validation; the browser can neither read nor write it directly, so no
-- visitor can pull the list.
-- source records where the lead came from ('popup' today; more later).
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  source text not null default 'popup',
  created_at timestamptz not null default now()
);

-- The same person tapping the popup twice must not become two leads. The
-- handler lowercases email before every insert, so a plain unique index is
-- correct AND it is what lets the upsert's ON CONFLICT (email) work: an
-- expression index on lower(email) cannot arbitrate that clause, and with
-- one in place every insert dies at plan time (42P10) — the whole endpoint
-- returns 500 while the demo, which dedupes in JS, works perfectly.
create unique index if not exists leads_email_key
  on public.leads (email);
drop index if exists public.leads_email_lower_idx;

alter table public.leads enable row level security;
-- No policies at all: only the service role reads or writes leads.

-- ---------------------------------------------------------------------------
-- reviews: real words from real clients, nothing else. A review can only be
-- created by a signed-in client (POST /api/reviews checks the session), the
-- name is snapshotted from their profile so nobody reviews under someone
-- else's name, and NOTHING shows on the site until Ebony approves it in her
-- dashboard. status: pending (new), approved (public), hidden (her call).
-- ---------------------------------------------------------------------------
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on update cascade on delete set null,
  name text not null,
  service text not null default '',
  rating integer not null check (rating between 1 and 5),
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'hidden')),
  created_at timestamptz not null default now()
);

-- One review per client, the latest wins: a returning client updates her
-- words (and goes back to pending for re-approval), and a hostile account
-- cannot flood the moderation queue with hundreds of rows. NOT a partial
-- index: ON CONFLICT (client_id) cannot be arbitrated by a partial index
-- (the same 42P10 failure the leads index had), and a plain unique index
-- still allows many NULLs, so reviews orphaned by a deleted account keep.
create unique index if not exists reviews_client_key
  on public.reviews (client_id);

alter table public.reviews enable row level security;

-- NO policies, not even a read for approved rows. A row-level policy cannot
-- hide columns, so a public select policy would let anyone with the anon key
-- read client_id (the auth user id) straight off PostgREST. Public reads go
-- through GET /api/reviews, which serves approved rows only and projects
-- exactly the public columns. Writes go through POST /api/reviews so the
-- name snapshot and the pending status can never be forged from a browser.
drop policy if exists reviews_public_read_approved on public.reviews;
