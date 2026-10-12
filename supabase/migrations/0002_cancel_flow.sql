-- =============================================================================
-- Unquit — week 2: the cancel-flow widget
--
-- Run this AFTER 0001_init.sql (Supabase → SQL Editor → paste → Run, or
-- `supabase db push`). Safe on a database that already has founders in it:
-- existing accounts get their widget keys generated automatically.
--
-- Adds
--   * accounts.widget_publishable_key   pk_…    goes in the <script> tag (public)
--   * accounts.widget_signing_secret    uqsk_…  stays on the founder's server (secret)
--   * flows                             the founder's exit survey + offers (RLS like week 1)
--   * cancel_sessions                   a few columns the widget records
--   * widget_rate_limits                fixed-window counters for the public API
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Widget keys on accounts
-- -----------------------------------------------------------------------------

-- gen_random_uuid() draws from Postgres' cryptographically strong RNG.
create or replace function public.new_widget_publishable_key()
returns text
language sql
volatile
as $$
  select 'pk_' || replace(gen_random_uuid()::text, '-', '');
$$;

create or replace function public.new_widget_signing_secret()
returns text
language sql
volatile
as $$
  select 'uqsk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Volatile defaults are evaluated per row, so every existing account gets its own keys.
alter table public.accounts
  add column widget_publishable_key text not null default public.new_widget_publishable_key(),
  add column widget_signing_secret  text not null default public.new_widget_signing_secret();

create unique index accounts_widget_publishable_key_key on public.accounts (widget_publishable_key);

-- Founders can still only INSERT (owner_user_id, name) and UPDATE (name):
-- the week-1 column grants already exclude the new columns, so keys can't
-- be chosen or overwritten from the browser. Rotation goes through this
-- function, which only ever touches the caller's own account.
create or replace function public.rotate_widget_signing_secret()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.accounts
     set widget_signing_secret = public.new_widget_signing_secret()
   where owner_user_id = auth.uid();
$$;

revoke execute on function public.rotate_widget_signing_secret() from public, anon;
grant execute on function public.rotate_widget_signing_secret() to authenticated;

-- -----------------------------------------------------------------------------
-- flows: the founder's cancel flow (exit-survey reasons -> offers)
-- `reasons` is validated in app code (lib/flows/schema.ts); the checks here
-- are a backstop.
-- -----------------------------------------------------------------------------

create table public.flows (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null unique references public.accounts (id) on delete cascade,
  template             text not null default 'balanced'
    check (template in ('discount_first', 'pause_first', 'balanced', 'custom')),
  -- [{"id":"too_expensive","label":"Too expensive","freeText":false,
  --   "offer":{"type":"discount","percentOff":30,"months":3}}, ...]
  reasons              jsonb not null
    check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) between 1 and 10),
  cancel_mode          text not null default 'period_end'
    check (cancel_mode in ('period_end', 'immediately')),
  -- Abuse guard: at most one accepted offer per subscription in this window.
  offer_cooldown_days  integer not null default 90
    check (offer_cooldown_days between 0 and 3650),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger flows_set_updated_at
  before update on public.flows
  for each row execute function public.set_updated_at();

alter table public.flows enable row level security;

create policy "flows: owner can read"
  on public.flows for select to authenticated
  using (public.is_account_owner(account_id));

create policy "flows: owner can create"
  on public.flows for insert to authenticated
  with check (public.is_account_owner(account_id));

create policy "flows: owner can update"
  on public.flows for update to authenticated
  using (public.is_account_owner(account_id))
  with check (public.is_account_owner(account_id));

create policy "flows: owner can delete"
  on public.flows for delete to authenticated
  using (public.is_account_owner(account_id));

-- -----------------------------------------------------------------------------
-- cancel_sessions: what the widget records
-- -----------------------------------------------------------------------------

alter table public.cancel_sessions
  add column reason_label   text,   -- the label the customer saw (reasons can be renamed later)
  add column offers_enabled boolean not null default true,  -- false = abuse guard skipped offers
  add column cancel_mode    text check (cancel_mode is null or cancel_mode in ('period_end', 'immediately'));

-- The abuse guard looks up the latest accepted offer per subscription.
create index cancel_sessions_accepted_idx
  on public.cancel_sessions (account_id, stripe_subscription_id, offer_accepted_at desc)
  where offer_accepted;

-- -----------------------------------------------------------------------------
-- saves: one save per cancel session / dunning case, as plain UNIQUE
-- constraints. Same rule as week 1's partial indexes (NULLs never clash),
-- but a plain constraint lets `insert ... on conflict (cancel_session_id)
-- do nothing` find it, which is how the accept endpoint stays idempotent.
-- -----------------------------------------------------------------------------

drop index if exists public.saves_cancel_session_key;
drop index if exists public.saves_dunning_case_key;
alter table public.saves
  add constraint saves_cancel_session_id_key unique (cancel_session_id),
  add constraint saves_dunning_case_id_key   unique (dunning_case_id);

-- -----------------------------------------------------------------------------
-- widget_rate_limits: fixed-window counters for the public widget API.
-- Service role only (RLS on, no policies; function not executable by users).
-- -----------------------------------------------------------------------------

create table public.widget_rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (bucket, window_start)
);

alter table public.widget_rate_limits enable row level security;

-- Counts one hit in the current window and returns true while the bucket
-- is within p_max. Old windows are pruned now and then.
create or replace function public.widget_rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
volatile
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n integer;
begin
  insert into public.widget_rate_limits as rl (bucket, window_start, hits)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = rl.hits + 1
  returning hits into n;

  if random() < 0.01 then
    delete from public.widget_rate_limits where window_start < now() - interval '1 day';
  end if;

  return n <= p_max;
end;
$$;

revoke execute on function public.widget_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
-- new_widget_publishable_key() / new_widget_signing_secret() stay executable:
-- they are the column defaults, so they run when a founder creates their
-- account row, and they only return fresh random strings.
