-- =============================================================================
-- 0011: overlap pricing + pausing an account whose Unquit bill is unpaid
--
-- 1. Overlap fee. When one end-customer invoice earns BOTH a cancel-save fee
--    (20% of saved MRR, months 1-3) and a failed-payment recovery fee, the
--    cancel-save fee is charged in full and the recovery fee is reduced to 5%
--    (lib/pricing.ts OVERLAP_RECOVERY_RATE_BPS). The reduced recovery line
--    remembers which cancel save it overlapped.
--
-- 2. Pause. A Dodo statement still unpaid after the final retry (or after a
--    hard decline with no new card) warns the founder, then after a 3-day
--    grace period pauses the account: no cancel-flow offers, no dunning
--    emails. End customers can always still cancel. Paying the outstanding
--    statement resumes the account automatically. Admins can pause/resume.
--    (lib/billing/pause.ts)
--
-- Written to be safe to apply twice (if not exists / drop-and-add).
-- =============================================================================

-- --- 1. overlap ---------------------------------------------------------------

alter table public.save_fee_lines
  add column if not exists overlap_save_id uuid references public.saves (id) on delete set null,
  add column if not exists overlap_reduced_at timestamptz;

alter table public.save_fee_lines drop constraint if exists save_fee_lines_overlap_pair;
alter table public.save_fee_lines
  add constraint save_fee_lines_overlap_pair check ((overlap_save_id is null) = (overlap_reduced_at is null));

alter table public.save_events drop constraint if exists save_events_kind_check;
alter table public.save_events
  add constraint save_events_kind_check check (kind in (
    'offer_accepted', 'invoice_paid', 'verified', 'fee_line', 'recovered',
    'lost', 'ended', 'refund', 'credit_note', 'stripe_dispute_opened', 'stripe_dispute_won',
    'stripe_dispute_lost', 'dispute_opened', 'dispute_accepted', 'dispute_rejected', 'billed',
    'overlap_reduced'
  ));

-- --- 2. pause -----------------------------------------------------------------

alter table public.accounts
  add column if not exists billing_pause_state text not null default 'active',
  -- 'auto' = unpaid bill (resumes by itself when paid), 'admin' = paused by an admin (admin resumes)
  add column if not exists billing_pause_source text,
  add column if not exists billing_pause_warned_at timestamptz,
  add column if not exists billing_pause_due_at timestamptz,
  add column if not exists billing_paused_at timestamptz,
  add column if not exists billing_resumed_at timestamptz,
  add column if not exists billing_pause_warning_emailed_at timestamptz,
  add column if not exists billing_pause_emailed_at timestamptz,
  add column if not exists billing_resume_emailed_at timestamptz;

alter table public.accounts drop constraint if exists accounts_billing_pause_state_check;
alter table public.accounts
  add constraint accounts_billing_pause_state_check check (billing_pause_state in ('active', 'warned', 'paused'));

alter table public.accounts drop constraint if exists accounts_billing_pause_source_check;
alter table public.accounts
  add constraint accounts_billing_pause_source_check check (billing_pause_source is null or billing_pause_source in ('auto', 'admin'));

alter table public.accounts drop constraint if exists accounts_billing_pause_consistent;
alter table public.accounts
  add constraint accounts_billing_pause_consistent check (
    (billing_pause_state = 'active')
    or (billing_pause_state = 'warned' and billing_pause_due_at is not null and billing_pause_warned_at is not null)
    or (billing_pause_state = 'paused' and billing_paused_at is not null and billing_pause_source is not null)
  );

create index if not exists accounts_billing_pause_idx on public.accounts (billing_pause_state) where billing_pause_state <> 'active';
