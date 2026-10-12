-- =============================================================================
-- Unquit — week 3: dunning (failed-payment recovery)
--
-- Run this AFTER 0001_init.sql and 0002_cancel_flow.sql (Supabase → SQL
-- Editor → paste → Run, or `supabase db push`). Safe on a live database:
-- existing dunning cases keep their data and get a fresh card-update link
-- nonce each.
--
-- Adds
--   * dunning_cases       decline code + category, the email sequence state,
--                         the card-update link nonce and pending attribution
--   * saves.attributed_via how a dunning save was won: update_link | unquit_retry
--   * dunning_settings    on/off, schedule (days), sender name, email templates (RLS)
--   * dunning_emails      one row per email in a sequence (RLS, read-only for founders)
--   * dunning_claim_email()  the cron's "send each email exactly once" lock
--   * dunning_record_click() the card-update link click counter
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dunning_cases: decline details, sequence state, link + attribution
-- -----------------------------------------------------------------------------

alter table public.dunning_cases
  add column decline_code            text,   -- e.g. insufficient_funds, expired_card, authentication_required
  add column decline_category        text
    check (decline_category is null or decline_category in ('soft', 'hard', 'authentication_required')),
  add column stripe_payment_intent_id text,
  add column customer_email          text,
  add column customer_name           text,
  add column invoice_number          text,
  -- How many emails of the 3-email sequence have gone out (0..3).
  add column sequence_step           smallint not null default 0 check (sequence_step between 0 and 3),
  -- When the next email is due. NULL = nothing more to send.
  add column next_email_at           timestamptz,
  add column sequence_stopped_at     timestamptz,
  add column sequence_stop_reason    text
    check (sequence_stop_reason is null or sequence_stop_reason in
      ('paid', 'canceled', 'completed', 'no_email', 'invoice_closed')),
  -- Part of every signed card-update link. Rotated when the case is
  -- recovered, so a link stops working the moment a payment succeeds.
  add column link_nonce              uuid not null default gen_random_uuid(),
  add column link_first_opened_at    timestamptz,
  add column link_last_opened_at     timestamptz,
  -- Set just BEFORE Unquit asks Stripe to pay the invoice (card-update page or
  -- "try my card again"). invoice.paid within the attribution window is
  -- credited to Unquit; anything else stays 'external' (no fee).
  add column pending_attribution     text
    check (pending_attribution is null or pending_attribution in ('update_link', 'unquit_retry')),
  add column pending_attribution_at  timestamptz,
  add constraint dunning_cases_pending_attribution_pair
    check ((pending_attribution is null) = (pending_attribution_at is null));

-- Week 1 named the link 'unquit_link'; week 3 uses 'update_link' everywhere.
-- Week 1 only ever wrote 'external', so nothing needs converting.
alter table public.dunning_cases drop constraint if exists dunning_cases_recovered_via_check;
alter table public.dunning_cases
  add constraint dunning_cases_recovered_via_check
    check (recovered_via is null or recovered_via in ('update_link', 'unquit_retry', 'external'));

-- The cron's "what is due now?" query.
create index dunning_cases_due_idx
  on public.dunning_cases (next_email_at)
  where status = 'open' and next_email_at is not null;
create index dunning_cases_subscription_idx
  on public.dunning_cases (account_id, stripe_subscription_id)
  where status = 'open';

-- -----------------------------------------------------------------------------
-- saves: how a dunning save was won
-- -----------------------------------------------------------------------------

alter table public.saves
  add column attributed_via text
    check (attributed_via is null or attributed_via in ('update_link', 'unquit_retry')),
  -- Every dunning save says how Unquit won it; cancel saves never do.
  add constraint saves_dunning_attribution
    check ((type = 'dunning') = (attributed_via is not null));

-- -----------------------------------------------------------------------------
-- dunning_settings: one row per founder account (missing row = defaults, OFF)
-- `templates` is validated in app code (lib/dunning/templates.ts); the checks
-- here are a backstop.
-- -----------------------------------------------------------------------------

create table public.dunning_settings (
  account_id      uuid primary key references public.accounts (id) on delete cascade,
  enabled         boolean not null default false,
  -- Days after the failed payment for emails 1, 2 and 3.
  schedule_days   integer[] not null default '{0,3,7}'
    check (
      array_length(schedule_days, 1) = 3
      and schedule_days[1] >= 0
      and schedule_days[1] < schedule_days[2]
      and schedule_days[2] < schedule_days[3]
      and schedule_days[3] <= 60
    ),
  -- The "from" name on every email and the name on the card-update page.
  company_name    text check (company_name is null or length(company_name) between 1 and 100),
  reply_to_email  text check (reply_to_email is null or (length(reply_to_email) <= 254 and reply_to_email like '%_@_%')),
  -- {"soft":[{"subject":"…","body":"…"}, …x3], "hard":[…], "authentication_required":[…]}
  -- Missing categories fall back to the built-in copy.
  templates       jsonb not null default '{}'::jsonb check (jsonb_typeof(templates) = 'object'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger dunning_settings_set_updated_at
  before update on public.dunning_settings
  for each row execute function public.set_updated_at();

alter table public.dunning_settings enable row level security;

create policy "dunning_settings: owner can read"
  on public.dunning_settings for select to authenticated
  using (public.is_account_owner(account_id));

create policy "dunning_settings: owner can create"
  on public.dunning_settings for insert to authenticated
  with check (public.is_account_owner(account_id));

create policy "dunning_settings: owner can update"
  on public.dunning_settings for update to authenticated
  using (public.is_account_owner(account_id))
  with check (public.is_account_owner(account_id));

-- -----------------------------------------------------------------------------
-- dunning_emails: every email Unquit sends (or logs) for a dunning case.
-- UNIQUE (dunning_case_id, step) is what makes cron runs idempotent.
-- -----------------------------------------------------------------------------

create table public.dunning_emails (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.accounts (id) on delete cascade,
  dunning_case_id      uuid not null references public.dunning_cases (id) on delete cascade,
  step                 smallint not null check (step between 0 and 2),
  category             text not null check (category in ('soft', 'hard', 'authentication_required')),
  to_email             text not null,
  subject              text not null,
  -- sending: claimed by a cron run · sent: accepted by Resend · logged: no
  -- RESEND_API_KEY, written to the logs · failed: will be retried (max 3)
  status               text not null default 'sending'
    check (status in ('sending', 'sent', 'logged', 'failed')),
  attempts             integer not null default 1 check (attempts >= 1),
  provider_message_id  text,
  error                text,
  claimed_at           timestamptz not null default now(),
  sent_at              timestamptz,
  opened_at            timestamptz,
  clicked_at           timestamptz,
  click_count          integer not null default 0 check (click_count >= 0),
  created_at           timestamptz not null default now(),
  unique (dunning_case_id, step)
);

create index dunning_emails_account_idx on public.dunning_emails (account_id, created_at desc);

alter table public.dunning_emails enable row level security;

create policy "dunning_emails: owner can read"
  on public.dunning_emails for select to authenticated
  using (public.is_account_owner(account_id));

-- -----------------------------------------------------------------------------
-- dunning_claim_email: take the lock for (case, step) before sending.
--   claimed       this caller sends it (new row, a failed one being retried,
--                 or a 'sending' row abandoned for 10+ minutes by a crashed run;
--                 Resend's idempotency key stops that last case double-sending)
--   already_sent  sent/logged before: just move the sequence on
--   in_flight     another run is sending it right now: leave it alone
--   gave_up       failed 3 times: move the sequence on without it
-- Service role only.
-- -----------------------------------------------------------------------------

create or replace function public.dunning_claim_email(
  p_account_id uuid,
  p_case_id    uuid,
  p_step       smallint,
  p_category   text,
  p_to_email   text,
  p_subject    text
)
returns table (email_id uuid, outcome text)
language plpgsql
volatile
as $$
declare
  v_id       uuid;
  v_status   text;
  v_attempts integer;
  v_claimed  timestamptz;
begin
  insert into public.dunning_emails (account_id, dunning_case_id, step, category, to_email, subject)
  values (p_account_id, p_case_id, p_step, p_category, p_to_email, p_subject)
  on conflict (dunning_case_id, step) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, 'claimed'::text;
    return;
  end if;

  select e.id, e.status, e.attempts, e.claimed_at into v_id, v_status, v_attempts, v_claimed
    from public.dunning_emails e
   where e.dunning_case_id = p_case_id and e.step = p_step
   for update;

  if v_status in ('sent', 'logged') then
    return query select v_id, 'already_sent'::text;
  elsif v_status = 'failed' and v_attempts >= 3 then
    return query select v_id, 'gave_up'::text;
  elsif v_status = 'failed' or (v_status = 'sending' and v_claimed < now() - interval '10 minutes') then
    update public.dunning_emails
       set status = 'sending', attempts = attempts + 1, error = null, claimed_at = now(),
           category = p_category, to_email = p_to_email, subject = p_subject
     where id = v_id;
    return query select v_id, 'claimed'::text;
  else
    return query select v_id, 'in_flight'::text;
  end if;
end;
$$;

revoke execute on function public.dunning_claim_email(uuid, uuid, smallint, text, text, text) from public, anon, authenticated;

-- Counts a click on an email's card-update link (first click time kept).
create or replace function public.dunning_record_click(p_email_id uuid)
returns boolean
language sql
volatile
as $$
  with e as (
    update public.dunning_emails
       set click_count = click_count + 1,
           clicked_at  = coalesce(clicked_at, now()),
           opened_at   = coalesce(opened_at, now())   -- a click proves an open
     where id = p_email_id
     returning dunning_case_id
  )
  select exists (select 1 from e);
$$;

revoke execute on function public.dunning_record_click(uuid) from public, anon, authenticated;
