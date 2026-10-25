-- One-time, hashed tokens for founder email verification and password resets.
create type public.auth_token_purpose as enum ('verify_email', 'reset_password');

create table public.auth_email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  purpose public.auth_token_purpose not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index auth_email_tokens_active_lookup
  on public.auth_email_tokens (token_hash, purpose, expires_at)
  where used_at is null;
