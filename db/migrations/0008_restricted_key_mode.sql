-- Restricted-key connection mode.
--
-- Stripe Connect (OAuth) is invite-only for platforms in some countries (e.g.
-- India), so founders can also connect by pasting a Stripe RESTRICTED key
-- (rk_live_ / rk_test_) that they created with only the permissions Unquit needs.
--
--   stripe_connection_mode            'connect' (OAuth, platform key + Stripe-Account header)
--                                     or 'key' (the founder's own restricted key)
--   stripe_key_ciphertext             the restricted key, AES-256-GCM encrypted by the app with
--                                     STRIPE_KEY_ENCRYPTION_KEY. Never stored in plain text.
--   stripe_key_last4                  the key's last 4 characters, the only part ever shown
--   stripe_publishable_key            the founder's pk_ (public by design): the card-update page
--                                     needs it for Stripe Elements on their account
--   stripe_webhook_endpoint_id        the we_ endpoint Unquit created on their account
--   stripe_webhook_secret_ciphertext  its whsec_ signing secret, encrypted like the key
--
-- Disconnecting wipes every key column (the app also deletes the endpoint in Stripe).
alter table public.accounts
  add column if not exists stripe_connection_mode text not null default 'connect'
    check (stripe_connection_mode in ('connect', 'key')),
  add column if not exists stripe_key_ciphertext text,
  add column if not exists stripe_key_last4 text check (stripe_key_last4 is null or length(stripe_key_last4) = 4),
  add column if not exists stripe_publishable_key text
    check (stripe_publishable_key is null or stripe_publishable_key ~ '^pk_(live|test)_[A-Za-z0-9]+$'),
  add column if not exists stripe_webhook_endpoint_id text,
  add column if not exists stripe_webhook_secret_ciphertext text;

-- Never a plain key in the ciphertext columns (defence in depth: the app writes "v1.<iv>.<tag>.<data>").
alter table public.accounts
  add constraint accounts_stripe_key_ciphertext_format
    check (stripe_key_ciphertext is null or stripe_key_ciphertext like 'v1.%'),
  add constraint accounts_stripe_webhook_secret_ciphertext_format
    check (stripe_webhook_secret_ciphertext is null or stripe_webhook_secret_ciphertext like 'v1.%');

-- A connected key-mode account always has its key and webhook secret.
alter table public.accounts
  add constraint accounts_key_mode_has_secrets
    check (
      stripe_connection_mode <> 'key'
      or stripe_connection_status <> 'connected'
      or (stripe_key_ciphertext is not null and stripe_webhook_secret_ciphertext is not null and stripe_key_last4 is not null)
    );
