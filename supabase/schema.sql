-- Sitting Pretty production schema (Supabase Postgres)
-- Contract: /API.md. Mock parity: server/ demo keeps the same shapes.
-- Run once on a fresh Supabase project (SQL Editor paste, or as a migration,
-- see RUNBOOK.md step 2). All writes in production go through the edge
-- functions using the service role key; RLS gives clients read access to
-- their own rows only.

create extension if not exists pgcrypto;
create extension if not exists btree_gist; -- for the bookings_overlap exclusion constraint

-- ---------------------------------------------------------------------------
-- clients: one row per auth user (Supabase Auth email OTP creates the user;
-- the trigger below creates this row on first sign-in).
-- Admin = clients.is_admin, checked in the edge functions (_shared/auth.ts
-- requireAdmin) with the service role key. There is no separate admin table.
-- ---------------------------------------------------------------------------
create table public.clients (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  name text,
  phone text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-create the client row when a new auth user signs in for the first time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.clients (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Grant Ke'Ebonie admin AFTER her first sign-in (RUNBOOK step 2).
-- PLACEHOLDER EMAIL: her real email is still unconfirmed. Replace before running.
-- update public.clients set is_admin = true where email = 'ebony@demo.local';

-- ---------------------------------------------------------------------------
-- bookings: one row per appointment. Client fields are snapshotted at booking
-- time so the dashboard still reads right if a client edits their profile.
-- Shape mirrors the Booking object in API.md.
-- ---------------------------------------------------------------------------
create table public.bookings (
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
alter table public.bookings add constraint bookings_overlap
  exclude using gist (
    date with =,
    (int4range(
      split_part("time", ':', 1)::int * 60 + split_part("time", ':', 2)::int,
      split_part("time", ':', 1)::int * 60 + split_part("time", ':', 2)::int + duration_min
    )) with &&
  ) where (status <> 'canceled');

-- ---------------------------------------------------------------------------
-- blocked_days: whole days Ebony closes from the dashboard (sick, holiday).
-- ---------------------------------------------------------------------------
create table public.blocked_days (
  date date primary key,
  reason text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- broadcasts: master messages sent to every client from the dashboard.
-- ---------------------------------------------------------------------------
create table public.broadcasts (
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
create table public.notifications_log (
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
-- Indexes
-- ---------------------------------------------------------------------------
create index bookings_date_status_idx on public.bookings (date, status);
create index bookings_client_created_idx on public.bookings (client_id, created_at desc);
create index bookings_stripe_session_idx on public.bookings (stripe_session_id);
create index notifications_log_booking_idx on public.notifications_log (booking_id);
create index notifications_log_created_idx on public.notifications_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Clients read their own rows. All writes (and every admin read) go through
-- the edge functions with the service role key, which bypasses RLS; admin is
-- authorized there via clients.is_admin. No update policies on purpose:
-- profile edits go through POST /api/me so a client can never flip is_admin.
-- ---------------------------------------------------------------------------
alter table public.clients enable row level security;
alter table public.bookings enable row level security;
alter table public.blocked_days enable row level security;
alter table public.broadcasts enable row level security;
alter table public.notifications_log enable row level security;

create policy clients_select_own on public.clients
  for select using (auth.uid() = id);

create policy bookings_select_own on public.bookings
  for select using (auth.uid() = client_id);

-- blocked_days, broadcasts, notifications_log: no client policies at all.
-- Only the service role reads or writes them.
