-- =============================================================================
-- Unquit — initial schema (week 1)
--
-- Run this once in Supabase → SQL Editor (paste the whole file, click Run),
-- or with the Supabase CLI: `supabase db push`.
--
-- Security model
--   * Every table has row-level security (RLS) switched ON.
--   * A signed-in founder can READ rows that belong to an account they own.
--   * Founders can create/update their own `accounts` row and open disputes.
--   * Everything else (webhook processing, ledger writes) is done on the
--     server with the service-role key, which bypasses RLS by design.
--   * Money is stored as integer cents. Never floats.
-- =============================================================================

-- gen_random_uuid() is built into Postgres 13+ (Supabase runs 15+), no extension needed.

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- accounts: one row per founder organisation (the Unquit customer)
-- -----------------------------------------------------------------------------

create table public.accounts (
  id                       uuid primary key default gen_random_uuid(),
  owner_user_id            uuid not null references auth.users (id) on delete cascade,
  name                     text,
  stripe_account_id        text,             -- acct_... of the founder's Stripe account
  stripe_connection_status text not null default 'not_connected'
    check (stripe_connection_status in ('not_connected', 'connected', 'disconnected', 'revoked')),
  stripe_livemode          boolean,
  stripe_scope             text,
  stripe_connected_at      timestamptz,
  stripe_disconnected_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Week 1: one organisation per founder. Relax this when teams arrive.
create unique index accounts_owner_user_id_key on public.accounts (owner_user_id);

-- A Stripe account can be actively connected to only one Unquit account.
-- (A disconnected row keeps its old acct_ id for history.)
create unique index accounts_connected_stripe_account_key
  on public.accounts (stripe_account_id)
  where stripe_connection_status = 'connected';
create index accounts_stripe_account_idx on public.accounts (stripe_account_id);

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

-- Used by every RLS policy below. SECURITY DEFINER so policies on child tables
-- don't recurse through the accounts policy.
create or replace function public.is_account_owner(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.accounts a
    where a.id = p_account_id and a.owner_user_id = auth.uid()
  );
$$;

-- -----------------------------------------------------------------------------
-- subscriptions_cache: a mirror of the founder's Stripe subscriptions,
-- kept fresh by webhooks. Used for MRR-at-risk and save verification.
-- -----------------------------------------------------------------------------

create table public.subscriptions_cache (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts (id) on delete cascade,
  stripe_subscription_id   text not null,
  stripe_customer_id       text not null,
  status                   text not null,  -- Stripe status: active, past_due, canceled, trialing, unpaid, paused, incomplete...
  mrr_cents                bigint not null default 0 check (mrr_cents >= 0),
  currency                 text not null default 'usd',
  cancel_at_period_end     boolean not null default false,
  current_period_end       timestamptz,
  canceled_at              timestamptz,
  stripe_created_at        timestamptz,
  -- `created` of the Stripe event that last wrote this row. Stops an older,
  -- late-arriving webhook from overwriting newer data.
  last_event_created_at    timestamptz not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (account_id, stripe_subscription_id)
);

create index subscriptions_cache_account_status_idx on public.subscriptions_cache (account_id, status);
create index subscriptions_cache_customer_idx on public.subscriptions_cache (account_id, stripe_customer_id);

create trigger subscriptions_cache_set_updated_at
  before update on public.subscriptions_cache
  for each row execute function public.set_updated_at();

-- Upsert that ignores out-of-order (older) events. Called by the webhook
-- with the service role.
create or replace function public.upsert_subscription_cache(
  p_account_id             uuid,
  p_stripe_subscription_id text,
  p_stripe_customer_id     text,
  p_status                 text,
  p_mrr_cents              bigint,
  p_currency               text,
  p_cancel_at_period_end   boolean,
  p_current_period_end     timestamptz,
  p_canceled_at            timestamptz,
  p_stripe_created_at      timestamptz,
  p_event_created_at       timestamptz
)
returns void
language sql
as $$
  insert into public.subscriptions_cache as sc (
    account_id, stripe_subscription_id, stripe_customer_id, status, mrr_cents,
    currency, cancel_at_period_end, current_period_end, canceled_at,
    stripe_created_at, last_event_created_at
  ) values (
    p_account_id, p_stripe_subscription_id, p_stripe_customer_id, p_status, p_mrr_cents,
    p_currency, p_cancel_at_period_end, p_current_period_end, p_canceled_at,
    p_stripe_created_at, p_event_created_at
  )
  on conflict (account_id, stripe_subscription_id) do update set
    stripe_customer_id    = excluded.stripe_customer_id,
    status                = excluded.status,
    mrr_cents             = excluded.mrr_cents,
    currency              = excluded.currency,
    cancel_at_period_end  = excluded.cancel_at_period_end,
    current_period_end    = excluded.current_period_end,
    canceled_at           = excluded.canceled_at,
    stripe_created_at     = excluded.stripe_created_at,
    last_event_created_at = excluded.last_event_created_at
  where sc.last_event_created_at <= excluded.last_event_created_at;
$$;

revoke execute on function public.upsert_subscription_cache(
  uuid, text, text, text, bigint, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- cancel_sessions: one row each time an end customer opens the cancel flow
-- (widget arrives in week 2).
-- -----------------------------------------------------------------------------

create table public.cancel_sessions (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts (id) on delete cascade,
  stripe_customer_id       text not null,
  stripe_subscription_id   text not null,
  reason                   text,           -- e.g. too_expensive, missing_feature, not_using, switching, other
  reason_detail            text,           -- free-text exit-survey answer
  offer_shown              jsonb,          -- e.g. {"type":"discount","percent_off":30,"months":3} or {"type":"pause","months":1}
  offer_accepted           boolean not null default false,
  offer_accepted_at        timestamptz,
  status                   text not null default 'started'
    check (status in ('started', 'offer_shown', 'offer_accepted', 'canceled', 'abandoned')),
  mrr_at_start_cents       bigint check (mrr_at_start_cents is null or mrr_at_start_cents >= 0),
  started_at               timestamptz not null default now(),
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint cancel_sessions_accept_consistency
    check (offer_accepted = false or offer_accepted_at is not null)
);

create index cancel_sessions_account_idx on public.cancel_sessions (account_id, created_at desc);
create index cancel_sessions_subscription_idx on public.cancel_sessions (account_id, stripe_subscription_id);

create trigger cancel_sessions_set_updated_at
  before update on public.cancel_sessions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- dunning_cases: one row per failed invoice we are trying to recover
-- (retries + card-update page arrive in week 3).
-- -----------------------------------------------------------------------------

create table public.dunning_cases (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts (id) on delete cascade,
  stripe_invoice_id        text not null,
  stripe_customer_id       text not null,
  stripe_subscription_id   text,
  amount_due_cents         bigint not null check (amount_due_cents >= 0),
  currency                 text not null default 'usd',
  attempt_count            integer not null default 0,
  last_failure_code        text,
  last_failure_message     text,
  next_payment_attempt_at  timestamptz,
  hosted_invoice_url       text,
  status                   text not null default 'open'
    check (status in ('open', 'recovered', 'failed', 'closed')),
  -- Who got the money in. Only 'unquit_retry' and 'unquit_link' count as a
  -- billable dunning save. Attribution logic lands in week 3.
  recovered_via            text
    check (recovered_via is null or recovered_via in ('unquit_retry', 'unquit_link', 'external')),
  recovered_amount_cents   bigint check (recovered_amount_cents is null or recovered_amount_cents >= 0),
  opened_at                timestamptz not null default now(),
  recovered_at             timestamptz,
  closed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (account_id, stripe_invoice_id)
);

create index dunning_cases_account_status_idx on public.dunning_cases (account_id, status);

create trigger dunning_cases_set_updated_at
  before update on public.dunning_cases
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- saves: THE LEDGER. Every billable save, with its receipt number.
-- Logic for fees, receipts and disputes lands in week 4; schema is final now.
--
-- Rules (enforced in app code, mirrored in constraints where possible):
--   cancel save  = customer accepted an in-flow offer AND their next invoice
--                  was paid. Created as 'pending', flipped to 'verified' by
--                  the invoice.paid webhook.
--   dunning save = a failed invoice paid through Unquit's retry or link.
-- -----------------------------------------------------------------------------

create sequence public.save_receipt_seq start 1000;

create table public.saves (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts (id) on delete cascade,
  type                     text not null check (type in ('cancel', 'dunning')),
  cancel_session_id        uuid references public.cancel_sessions (id) on delete set null,
  dunning_case_id          uuid references public.dunning_cases (id) on delete set null,
  stripe_customer_id       text not null,
  stripe_subscription_id   text,
  -- cancel: the "next invoice" that proved the save. dunning: the recovered invoice.
  stripe_invoice_id        text,
  offer                    jsonb,           -- snapshot of the accepted offer (cancel saves)
  saved_mrr_cents          bigint not null default 0 check (saved_mrr_cents >= 0),
  recovered_amount_cents   bigint not null default 0 check (recovered_amount_cents >= 0),
  currency                 text not null default 'usd',
  fee_cents                bigint not null default 0 check (fee_cents >= 0),  -- total fee earned so far (before monthly cap)
  status                   text not null default 'pending'
    check (status in ('pending', 'verified', 'disputed', 'clawed_back')),
  verified_at              timestamptz,
  clawed_back_at           timestamptz,
  receipt_number           text not null unique
    default ('UQ-' || lpad(nextval('public.save_receipt_seq')::text, 7, '0')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint saves_type_links check (
    (type = 'cancel'  and cancel_session_id is not null) or
    (type = 'dunning' and dunning_case_id  is not null)
  ),
  constraint saves_verified_has_timestamp check (
    status = 'pending' or verified_at is not null or status = 'clawed_back'
  )
);

-- A cancel session can produce at most one save; same for a dunning case.
create unique index saves_cancel_session_key on public.saves (cancel_session_id) where cancel_session_id is not null;
create unique index saves_dunning_case_key   on public.saves (dunning_case_id)   where dunning_case_id   is not null;
create index saves_account_status_idx on public.saves (account_id, status, created_at desc);
create index saves_pending_subscription_idx on public.saves (account_id, stripe_subscription_id) where status = 'pending';

create trigger saves_set_updated_at
  before update on public.saves
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- save_fee_lines: the month-by-month fee each save earns.
--   cancel save  -> up to 3 lines (20% of saved MRR each month the customer pays)
--   dunning save -> 1 line (10% of the recovered amount)
-- The $299/month cap is applied when the founder's monthly bill is built.
-- -----------------------------------------------------------------------------

create table public.save_fee_lines (
  id                       uuid primary key default gen_random_uuid(),
  save_id                  uuid not null references public.saves (id) on delete cascade,
  account_id               uuid not null references public.accounts (id) on delete cascade,
  month_index              smallint not null check (month_index between 1 and 3),
  billing_month            date not null,   -- first day of the month this line is billed in
  stripe_invoice_id        text,            -- the end-customer invoice that earned this line
  amount_cents             bigint not null check (amount_cents >= 0),
  status                   text not null default 'earned'
    check (status in ('earned', 'billed', 'clawed_back')),
  created_at               timestamptz not null default now(),
  unique (save_id, month_index)
);

create index save_fee_lines_account_month_idx on public.save_fee_lines (account_id, billing_month);

-- -----------------------------------------------------------------------------
-- disputes: founder presses "Dispute" on a save receipt.
-- -----------------------------------------------------------------------------

create table public.disputes (
  id                       uuid primary key default gen_random_uuid(),
  save_id                  uuid not null references public.saves (id) on delete cascade,
  account_id               uuid not null references public.accounts (id) on delete cascade,
  opened_by                uuid references auth.users (id) on delete set null,
  reason                   text not null check (length(reason) between 1 and 2000),
  status                   text not null default 'open'
    check (status in ('open', 'accepted', 'rejected')),
  resolution_note          text,
  created_at               timestamptz not null default now(),
  resolved_at              timestamptz
);

create index disputes_account_idx on public.disputes (account_id, created_at desc);
create unique index disputes_one_open_per_save on public.disputes (save_id) where status = 'open';

-- -----------------------------------------------------------------------------
-- webhook_events: idempotency log. Stripe can deliver the same event more
-- than once; we process each event id exactly once.
-- -----------------------------------------------------------------------------

create table public.webhook_events (
  stripe_event_id          text primary key,
  type                     text not null,
  stripe_account_id        text,
  livemode                 boolean not null default false,
  status                   text not null default 'processing'
    check (status in ('processing', 'processed', 'failed', 'ignored')),
  attempts                 integer not null default 1,
  error                    text,
  event_created_at         timestamptz,
  received_at              timestamptz not null default now(),
  processed_at             timestamptz
);

create index webhook_events_account_idx on public.webhook_events (stripe_account_id, received_at desc);

-- =============================================================================
-- Row-level security
-- =============================================================================

alter table public.accounts            enable row level security;
alter table public.subscriptions_cache enable row level security;
alter table public.cancel_sessions     enable row level security;
alter table public.dunning_cases       enable row level security;
alter table public.saves               enable row level security;
alter table public.save_fee_lines      enable row level security;
alter table public.disputes            enable row level security;
alter table public.webhook_events      enable row level security;  -- no policies: service role only

-- accounts: founders see and manage only their own row.
create policy "accounts: owner can read"
  on public.accounts for select to authenticated
  using (owner_user_id = auth.uid());

create policy "accounts: owner can create"
  on public.accounts for insert to authenticated
  with check (owner_user_id = auth.uid());

-- Founders may rename their org. Stripe fields are written by the server only
-- (see column grants below).
create policy "accounts: owner can update"
  on public.accounts for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- Column-level grants: a founder can only ever set owner + name. Stripe
-- fields can't be forged from the browser (e.g. claiming someone else's
-- acct_ id); only the server, after a real OAuth exchange, writes them.
revoke insert, update on public.accounts from authenticated, anon;
grant insert (owner_user_id, name) on public.accounts to authenticated;
grant update (name) on public.accounts to authenticated;

-- Read-only for founders; written by the server.
create policy "subscriptions_cache: owner can read"
  on public.subscriptions_cache for select to authenticated
  using (public.is_account_owner(account_id));

create policy "cancel_sessions: owner can read"
  on public.cancel_sessions for select to authenticated
  using (public.is_account_owner(account_id));

create policy "dunning_cases: owner can read"
  on public.dunning_cases for select to authenticated
  using (public.is_account_owner(account_id));

create policy "saves: owner can read"
  on public.saves for select to authenticated
  using (public.is_account_owner(account_id));

create policy "save_fee_lines: owner can read"
  on public.save_fee_lines for select to authenticated
  using (public.is_account_owner(account_id));

create policy "disputes: owner can read"
  on public.disputes for select to authenticated
  using (public.is_account_owner(account_id));

-- Founders can open a dispute on one of their own saves (the receipt's Dispute button).
create policy "disputes: owner can open"
  on public.disputes for insert to authenticated
  with check (
    public.is_account_owner(account_id)
    and opened_by = auth.uid()
    and status = 'open'
    and exists (
      select 1 from public.saves s
      where s.id = save_id and s.account_id = disputes.account_id
    )
  );
