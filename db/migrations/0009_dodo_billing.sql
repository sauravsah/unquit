-- =============================================================================
-- 0009: unquit's own fees are charged automatically through Dodo Payments
--
-- Dodo Payments is the merchant of record for unquit's fees. A founder saves
-- a card once through a Dodo checkout that creates an ON-DEMAND subscription
-- (mandate only, nothing charged). On the 1st, each closed monthly statement
-- is charged to that card with POST /subscriptions/{id}/charge.
--
--   * accounts            the founder's Dodo customer, subscription and status
--   * billing_periods     'closed' status, carried-forward small amounts and
--                         the statement's payment status
--   * billing_charges     ONE charge per statement (unique period id): the
--                         idempotency guard against double charging
--   * billing_charge_attempts  each payment attempt against Dodo (4 per cycle:
--                         day 0, +3, +10, +17), unique per (charge, attempt)
--   * billing_refunds     refunds Dodo reports on those payments
--   * dodo_webhook_events webhook-id log, so a redelivered webhook is a no-op
-- =============================================================================

-- -----------------------------------------------------------------------------
-- accounts: the billing method (Dodo on-demand subscription)
-- -----------------------------------------------------------------------------

alter table public.accounts
  add column dodo_customer_id          text,
  add column dodo_subscription_id      text,
  -- Dodo's subscription status: pending, active, on_hold, paused, cancelled, failed, expired, past_due.
  add column dodo_subscription_status  text,
  add column dodo_payment_method_id    text,
  add column dodo_checkout_session_id  text,
  add column dodo_mandate_at           timestamptz,
  add column dodo_status_at            timestamptz;

create unique index accounts_dodo_subscription_key on public.accounts (dodo_subscription_id) where dodo_subscription_id is not null;
create index accounts_dodo_customer_idx on public.accounts (dodo_customer_id) where dodo_customer_id is not null;

-- -----------------------------------------------------------------------------
-- billing_periods: closed statements, carry-forward, payment status
-- -----------------------------------------------------------------------------

alter table public.billing_periods drop constraint if exists billing_periods_status_check;
alter table public.billing_periods
  -- closed: statement final, collected by a Dodo charge (or carried forward when tiny)
  add constraint billing_periods_status_check check (status in ('building', 'invoiced', 'closed', 'zero', 'failed'));

alter table public.billing_periods
  -- Amounts below the minimum charge carried in from earlier statements.
  add column carried_in_cents      bigint not null default 0 check (carried_in_cents >= 0),
  -- What this statement asks for: its own total plus anything carried in.
  add column amount_due_cents      bigint not null default 0 check (amount_due_cents >= 0),
  -- Set when this (tiny) statement was rolled into a later one.
  add column carried_to_period_id  uuid references public.billing_periods (id) on delete set null,
  -- carried_forward: below the minimum charge, added to the next statement
  -- scheduled / awaiting_card / processing / retrying / paid / unpaid / refunded / partially_refunded: mirrors billing_charges.status
  add column payment_status        text
    check (payment_status is null or payment_status in
      ('carried_forward', 'scheduled', 'awaiting_card', 'processing', 'retrying', 'paid', 'unpaid', 'refunded', 'partially_refunded')),
  add constraint billing_periods_amount_due_maths check (amount_due_cents = total_cents + carried_in_cents),
  add constraint billing_periods_not_carried_to_self check (carried_to_period_id is null or carried_to_period_id <> id);

create index billing_periods_carried_idx on public.billing_periods (account_id)
  where payment_status = 'carried_forward' and carried_to_period_id is null;

-- -----------------------------------------------------------------------------
-- billing_charges: one per statement
-- -----------------------------------------------------------------------------

create table public.billing_charges (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references public.accounts (id) on delete cascade,
  billing_period_id     uuid not null unique references public.billing_periods (id) on delete cascade,
  amount_cents          bigint not null check (amount_cents > 0),
  currency              text not null default 'USD' check (currency = 'USD'),
  -- scheduled: waiting for next_attempt_at · awaiting_card: no usable card yet ·
  -- processing: a payment is in flight at Dodo · retrying: failed, next attempt scheduled ·
  -- paid · unpaid: retries exhausted or a hard decline · refunded / partially_refunded
  status                text not null default 'scheduled'
    check (status in ('scheduled', 'awaiting_card', 'processing', 'retrying', 'paid', 'unpaid', 'refunded', 'partially_refunded')),
  -- Every attempt ever made. A card update starts a new cycle of up to 4 attempts; 8 is a hard ceiling.
  attempts_count        integer not null default 0 check (attempts_count between 0 and 8),
  -- The current cycle: its first attempt's time anchors the retries (+3, +10, +17 days, same time of day).
  cycle_started_at      timestamptz,
  cycle_attempts        integer not null default 0 check (cycle_attempts between 0 and 4),
  next_attempt_at       timestamptz,
  dodo_subscription_id  text,
  dodo_payment_id       text,          -- latest attempt's payment
  last_error_code       text,
  last_error_message    text,
  hard_declined         boolean not null default false,
  receipt_url           text,          -- Dodo's invoice PDF for the paid payment
  refunded_cents        bigint not null default 0 check (refunded_cents >= 0),
  paid_at               timestamptz,
  unpaid_at             timestamptz,
  failure_emailed_at    timestamptz,
  unpaid_emailed_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint billing_charges_paid_has_time check (status not in ('paid', 'refunded', 'partially_refunded') or paid_at is not null),
  constraint billing_charges_unpaid_has_time check (status <> 'unpaid' or unpaid_at is not null),
  constraint billing_charges_scheduled_has_time check (status not in ('scheduled', 'retrying') or next_attempt_at is not null),
  constraint billing_charges_refund_range check (refunded_cents <= amount_cents)
);

create index billing_charges_due_idx on public.billing_charges (next_attempt_at) where status in ('scheduled', 'retrying');
create index billing_charges_account_idx on public.billing_charges (account_id, created_at desc);
create index billing_charges_waiting_idx on public.billing_charges (account_id) where status = 'awaiting_card';

create trigger billing_charges_set_updated_at
  before update on public.billing_charges
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- billing_charge_attempts: each POST /subscriptions/{id}/charge
-- -----------------------------------------------------------------------------

create table public.billing_charge_attempts (
  id               uuid primary key default gen_random_uuid(),
  charge_id        uuid not null references public.billing_charges (id) on delete cascade,
  attempt_no       integer not null check (attempt_no between 1 and 8),
  -- sending: claimed, request in flight (or its outcome unknown) · processing: Dodo returned a payment id ·
  -- succeeded / failed: the payment's outcome · not_created: Dodo never created a payment
  state            text not null default 'sending'
    check (state in ('sending', 'processing', 'succeeded', 'failed', 'not_created')),
  amount_cents     bigint not null check (amount_cents > 0),
  dodo_payment_id  text unique,
  error_code       text,
  error_message    text,
  sent_at          timestamptz not null default now(),
  resolved_at      timestamptz,
  unique (charge_id, attempt_no)
);

-- At most one attempt in flight per charge.
create unique index billing_charge_attempts_one_in_flight on public.billing_charge_attempts (charge_id)
  where state in ('sending', 'processing');

-- -----------------------------------------------------------------------------
-- billing_refunds
-- -----------------------------------------------------------------------------

create table public.billing_refunds (
  dodo_refund_id   text primary key,
  charge_id        uuid references public.billing_charges (id) on delete set null,
  account_id       uuid references public.accounts (id) on delete cascade,
  dodo_payment_id  text not null,
  amount_cents     bigint not null check (amount_cents >= 0),
  currency         text,
  status           text,
  created_at       timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- dodo_webhook_events: idempotency by webhook-id
-- -----------------------------------------------------------------------------

create table public.dodo_webhook_events (
  webhook_id    text primary key,
  event_type    text not null,
  object_id     text,
  status        text not null default 'processing' check (status in ('processing', 'processed', 'ignored', 'failed')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
