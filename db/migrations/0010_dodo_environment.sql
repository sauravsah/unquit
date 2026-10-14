-- =============================================================================
-- 0010: remember which Dodo Payments environment a billing method belongs to
--
-- Dodo test mode and live mode are separate worlds: a customer, subscription
-- or payment created with the test key does not exist for the live key. When
-- unquit switches DODO_PAYMENTS_ENVIRONMENT, a mandate saved in the other
-- environment is treated as "no card" (lib/billing/dodo/service.ts
-- methodForEnvironment), so a live run never tries to charge test ids. The
-- founder simply adds a card again in the new environment.
-- =============================================================================

alter table public.accounts
  add column dodo_environment text
    check (dodo_environment is null or dodo_environment in ('test_mode', 'live_mode'));

-- Every Dodo id stored before this migration came from test mode.
update public.accounts
   set dodo_environment = 'test_mode'
 where dodo_environment is null
   and (dodo_customer_id is not null or dodo_subscription_id is not null);
