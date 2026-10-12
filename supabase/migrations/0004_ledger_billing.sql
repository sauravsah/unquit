-- =============================================================================
-- Unquit — week 4: the save ledger, receipts, disputes, clawbacks and
-- unquit's own monthly billing.
--
-- Run this AFTER 0001, 0002 and 0003 (Supabase → SQL Editor → paste → Run, or
-- `supabase db push`). Safe on a live database: existing saves and fee lines
-- keep their data (dunning fee lines learn the invoice amount they came from).
--
-- Adds
--   * saves             'lost' status (+ why/when), the end of fee accrual,
--                       the customer's email and the receipt-email marker
--   * save_fee_lines    pro-rata clawbacks, Stripe-dispute and founder-dispute
--                       holds, which monthly statement billed the line
--   * invoice_reversals what Stripe says came back on an invoice (refunds,
--                       credit notes, lost disputes), one row per source
--   * fee_clawbacks     every fee reversal, for the receipt
--   * save_events       the receipt's timeline (append-only)
--   * disputes          category, note, auto/admin resolution, evidence
--   * billing_periods   one statement per founder per month (idempotency)
--   * accounts          unquit's own Stripe customer + payment-method status
--
-- Security: founders can READ their own rows in every new table. Nothing in
-- the ledger, the statuses or billing can be written from the browser: those
-- writes are made by server code with the service-role key. Disputes are now
-- opened through the server too (so holds and auto-rules always run).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- billing_periods (created first: fee lines point at it)
-- -----------------------------------------------------------------------------

create table public.billing_periods (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references public.accounts (id) on delete cascade,
  -- First day of the calendar month (UTC) this statement covers.
  period_month          date not null check (extract(day from period_month) = 1),
  -- building: claimed by a run · invoiced: Stripe invoice finalized ·
  -- zero: nothing to charge (statement only) · failed: will be retried
  status                text not null default 'building'
    check (status in ('building', 'invoiced', 'zero', 'failed')),
  cancel_fees_cents     bigint not null default 0 check (cancel_fees_cents >= 0),
  cancel_lines_count    integer not null default 0 check (cancel_lines_count >= 0),
  dunning_fees_cents    bigint not null default 0 check (dunning_fees_cents >= 0),
  dunning_lines_count   integer not null default 0 check (dunning_lines_count >= 0),
  clawed_back_cents     bigint not null default 0 check (clawed_back_cents >= 0),
  gross_cents           bigint not null default 0 check (gross_cents >= 0),
  cap_cents             bigint not null default 29900 check (cap_cents >= 0),
  cap_discount_cents    bigint not null default 0 check (cap_discount_cents >= 0),
  -- gross after the cap: what this month's own fees came to.
  capped_cents          bigint not null default 0 check (capped_cents >= 0),
  -- refunds/disputes on fees already billed in earlier statements.
  credit_applied_cents  bigint not null default 0 check (credit_applied_cents >= 0),
  total_cents           bigint not null default 0 check (total_cents >= 0),
  stripe_invoice_id     text,
  hosted_invoice_url    text,
  invoice_pdf_url       text,
  invoice_status        text,   -- Stripe's: draft, open, paid, void, uncollectible
  attempts              integer not null default 0 check (attempts >= 0),
  locked_at             timestamptz,
  error                 text,
  computed_at           timestamptz,
  finalized_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (account_id, period_month),
  constraint billing_periods_cap_maths check (capped_cents = gross_cents - cap_discount_cents and capped_cents <= cap_cents),
  constraint billing_periods_total_maths check (total_cents = capped_cents - credit_applied_cents),
  constraint billing_periods_invoiced_has_invoice check (status <> 'invoiced' or stripe_invoice_id is not null)
);

create index billing_periods_invoice_idx on public.billing_periods (stripe_invoice_id) where stripe_invoice_id is not null;

create trigger billing_periods_set_updated_at
  before update on public.billing_periods
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- saves: lost, ended, customer email, receipt email
-- -----------------------------------------------------------------------------

alter table public.saves drop constraint if exists saves_status_check;
alter table public.saves
  add constraint saves_status_check
    check (status in ('pending', 'verified', 'disputed', 'clawed_back', 'lost'));

alter table public.saves drop constraint if exists saves_verified_has_timestamp;
alter table public.saves
  add constraint saves_verified_has_timestamp
    check (status in ('pending', 'lost', 'clawed_back') or verified_at is not null);

alter table public.saves
  add column customer_email      text,
  -- A pending save that never verified: expired (no qualifying paid invoice
  -- in time), superseded (a later cancel session on the same subscription),
  -- or customer_canceled (the subscription was cancelled).
  add column lost_at             timestamptz,
  add column lost_reason         text
    check (lost_reason is null or lost_reason in ('expired', 'superseded', 'customer_canceled')),
  -- A verified cancel save whose subscription later ended: earned fees stand,
  -- no further months are added.
  add column ended_at            timestamptz,
  add column end_reason          text
    check (end_reason is null or end_reason in ('customer_canceled', 'superseded')),
  add column receipt_emailed_at  timestamptz,
  add constraint saves_lost_pair check ((status = 'lost') = (lost_at is not null and lost_reason is not null)),
  add constraint saves_end_pair check ((ended_at is null) = (end_reason is null));

create index saves_pending_created_idx on public.saves (created_at) where status = 'pending';
create index saves_account_receipt_idx on public.saves (account_id, receipt_number);

-- -----------------------------------------------------------------------------
-- save_fee_lines: clawbacks, holds, billing
-- -----------------------------------------------------------------------------

alter table public.save_fee_lines
  -- What the end customer paid on the invoice that earned this line. The
  -- denominator for pro-rata refunds.
  add column invoice_amount_paid_cents bigint check (invoice_amount_paid_cents is null or invoice_amount_paid_cents >= 0),
  add column clawed_back_cents         bigint not null default 0,
  -- Held while a Stripe dispute (chargeback) on the invoice is open...
  add column held_stripe_dispute_id    text,
  -- ...or while the founder's own dispute of the save is open.
  add column held_founder_dispute_id   uuid references public.disputes (id) on delete set null,
  add column billing_period_id         uuid references public.billing_periods (id) on delete set null,
  add column billed_at                 timestamptz,
  add constraint save_fee_lines_clawback_range check (clawed_back_cents between 0 and amount_cents),
  add constraint save_fee_lines_one_line_per_invoice unique (save_id, stripe_invoice_id);

-- Week 1 lines: dunning lines were earned on the recovered invoice; anything
-- already marked clawed_back was reversed in full.
update public.save_fee_lines l
   set invoice_amount_paid_cents = s.recovered_amount_cents
  from public.saves s
 where s.id = l.save_id and s.type = 'dunning' and l.invoice_amount_paid_cents is null;
update public.save_fee_lines set clawed_back_cents = amount_cents where status = 'clawed_back';

create index save_fee_lines_invoice_idx on public.save_fee_lines (account_id, stripe_invoice_id);
create index save_fee_lines_unbilled_idx on public.save_fee_lines (account_id, billing_month) where billing_period_id is null;
create index save_fee_lines_period_idx on public.save_fee_lines (billing_period_id) where billing_period_id is not null;

-- -----------------------------------------------------------------------------
-- invoice_reversals: money that came back to the end customer on an invoice.
-- One row per Stripe source, holding that source's CUMULATIVE amount, so a
-- re-delivered or out-of-order webhook can't count it twice:
--   charge:<ch_…>        charge.amount_refunded (refunds, incl. credit-note refunds)
--   credit_note:<cn_…>   the part of a credit note that is NOT a refund
--                        (credit to balance / out of band); 0 once voided
--   dispute:<dp_…>       the disputed amount, once the dispute is lost
-- -----------------------------------------------------------------------------

create table public.invoice_reversals (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.accounts (id) on delete cascade,
  stripe_invoice_id  text not null,
  source_key         text not null,
  kind               text not null check (kind in ('refund', 'credit_note', 'dispute_lost')),
  amount_cents       bigint not null check (amount_cents >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (account_id, source_key)
);

create index invoice_reversals_invoice_idx on public.invoice_reversals (account_id, stripe_invoice_id);

create trigger invoice_reversals_set_updated_at
  before update on public.invoice_reversals
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- fee_clawbacks: each reversal of (part of) a fee line, shown on the receipt.
-- -----------------------------------------------------------------------------

create table public.fee_clawbacks (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts (id) on delete cascade,
  save_id       uuid not null references public.saves (id) on delete cascade,
  fee_line_id   uuid not null references public.save_fee_lines (id) on delete cascade,
  kind          text not null
    check (kind in ('refund', 'credit_note', 'dispute_lost', 'dispute_accepted', 'dispute_auto')),
  source        text,          -- the Stripe object or dispute id behind it
  amount_cents  bigint not null check (amount_cents > 0),
  created_at    timestamptz not null default now()
);

create index fee_clawbacks_save_idx on public.fee_clawbacks (save_id, created_at);

-- -----------------------------------------------------------------------------
-- save_events: the receipt timeline. dedupe_key stops a re-delivered webhook
-- from adding the same line twice.
-- -----------------------------------------------------------------------------

create table public.save_events (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts (id) on delete cascade,
  save_id      uuid not null references public.saves (id) on delete cascade,
  kind         text not null check (kind in (
    'offer_accepted', 'invoice_paid', 'verified', 'fee_line', 'recovered',
    'lost', 'ended', 'refund', 'credit_note', 'stripe_dispute_opened', 'stripe_dispute_won',
    'stripe_dispute_lost', 'dispute_opened', 'dispute_accepted', 'dispute_rejected', 'billed'
  )),
  detail       jsonb not null default '{}'::jsonb,
  dedupe_key   text unique,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index save_events_save_idx on public.save_events (save_id, occurred_at);

-- -----------------------------------------------------------------------------
-- disputes: the receipt's "Dispute this save" button
-- -----------------------------------------------------------------------------

alter table public.disputes
  add column category             text not null default 'other'
    check (category in ('would_have_stayed', 'wrong_customer', 'refunded', 'other')),
  add column note                 text check (note is null or length(note) <= 2000),
  add column resolution           text check (resolution is null or resolution in ('auto', 'admin')),
  add column resolved_by          text,
  -- The evidence checks the auto-rules ran: {"checks":[{"invoice":"in_…","paid":true,…}],"failed":[…]}
  add column evidence             jsonb,
  add column founder_notified_at  timestamptz,
  add constraint disputes_resolved_pair check ((status = 'open') = (resolved_at is null));

create index disputes_open_idx on public.disputes (created_at) where status = 'open';

-- Week 1 let founders insert disputes straight from the browser. That would
-- skip the fee holds and the evidence checks, so disputes are now opened by
-- the server (/api/saves/<receipt>/dispute) after checking the founder owns
-- the save. Founders can still READ their disputes.
drop policy if exists "disputes: owner can open" on public.disputes;

-- -----------------------------------------------------------------------------
-- accounts: unquit's own billing (the PLATFORM Stripe account)
-- -----------------------------------------------------------------------------

alter table public.accounts
  add column platform_customer_id   text,   -- cus_… on unquit's own Stripe account
  add column billing_pm_status      text not null default 'none' check (billing_pm_status in ('none', 'active')),
  add column billing_pm_brand       text,
  add column billing_pm_last4       text check (billing_pm_last4 is null or billing_pm_last4 ~ '^[0-9]{4}$'),
  add column billing_pm_updated_at  timestamptz;

create unique index accounts_platform_customer_key on public.accounts (platform_customer_id) where platform_customer_id is not null;

-- The week-1 column grants still apply: founders can only insert
-- (owner_user_id, name) and update (name). The new billing columns are
-- written by the server only.

-- =============================================================================
-- Row-level security for the new tables: owner can read, nobody writes from
-- the browser. Writes on the ledger tables are also revoked at the privilege
-- level, so even a future permissive policy couldn't open them up by mistake.
-- =============================================================================

alter table public.billing_periods   enable row level security;
alter table public.invoice_reversals enable row level security;
alter table public.fee_clawbacks     enable row level security;
alter table public.save_events       enable row level security;

create policy "billing_periods: owner can read"
  on public.billing_periods for select to authenticated
  using (public.is_account_owner(account_id));

create policy "invoice_reversals: owner can read"
  on public.invoice_reversals for select to authenticated
  using (public.is_account_owner(account_id));

create policy "fee_clawbacks: owner can read"
  on public.fee_clawbacks for select to authenticated
  using (public.is_account_owner(account_id));

create policy "save_events: owner can read"
  on public.save_events for select to authenticated
  using (public.is_account_owner(account_id));

revoke insert, update, delete, truncate on
  public.saves, public.save_fee_lines, public.disputes, public.billing_periods,
  public.invoice_reversals, public.fee_clawbacks, public.save_events
  from anon, authenticated;
