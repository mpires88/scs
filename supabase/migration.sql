-- ═══════════════════════════════════════════════════════════════════════════
-- SCS Finance — schema migration & security lockdown
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run
-- Safe to re-run (idempotent).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Chart of accounts: move classifications out of localStorage ──────────
alter table public.categories add column if not exists pl_section text;
alter table public.categories add column if not exists parent     text;
alter table public.categories add column if not exists cost_type  text
  check (cost_type in ('fixed', 'variable') or cost_type is null);

-- ── 2. Key/value settings (cash balance, budgets, COGS estimates) ───────────
create table if not exists public.client_settings (
  client_id  uuid        not null,
  key        text        not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (client_id, key)
);

-- ── 3. Inventory buys (card shows, collection buys, distributors) ───────────
create table if not exists public.inventory_buys (
  id         uuid        primary key default gen_random_uuid(),
  client_id  uuid        not null,
  buy_date   date        not null,
  description text       not null,
  category   text,
  source     text,
  cost       numeric     not null,
  created_at timestamptz not null default now()
);

-- ── 4. Row Level Security ────────────────────────────────────────────────────
-- Single-owner model: any signed-in (authenticated) user has full access;
-- the public anon key can read/write NOTHING once these are in place.
-- (When a second user ever joins, tighten these to check auth.uid().)

alter table public.bank_transactions enable row level security;
alter table public.categories        enable row level security;
alter table public.square_reports    enable row level security;
alter table public.client_settings   enable row level security;
alter table public.inventory_buys    enable row level security;

drop policy if exists "authenticated full access" on public.bank_transactions;
create policy "authenticated full access" on public.bank_transactions
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.categories;
create policy "authenticated full access" on public.categories
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.square_reports;
create policy "authenticated full access" on public.square_reports
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.client_settings;
create policy "authenticated full access" on public.client_settings
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.inventory_buys;
create policy "authenticated full access" on public.inventory_buys
  for all to authenticated using (true) with check (true);
