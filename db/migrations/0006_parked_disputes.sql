-- Stripe can send charge.dispute.created BEFORE invoice.paid (an instant
-- early-fraud dispute). At that moment no fee line exists for the invoice yet,
-- so the dispute is parked here and replayed once invoice.paid creates the lines.
create table if not exists public.parked_stripe_disputes (
  dispute_id     text primary key,
  account_id     uuid not null references public.accounts (id) on delete cascade,
  invoice_id     text not null,
  status         text not null,
  amount_cents   bigint not null,
  received_at    timestamptz not null default now()
);

create index if not exists parked_stripe_disputes_invoice_idx
  on public.parked_stripe_disputes (account_id, invoice_id);
