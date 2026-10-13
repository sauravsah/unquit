-- =============================================================================
-- Unquit — auth on plain Postgres (replaces Supabase Auth)
--
-- Applied after 0001-0004 by `npm run db:migrate`.
--
-- Founders sign in with email + password through Auth.js (Credentials
-- provider, JWT sessions). Passwords are bcrypt hashes; the plain password is
-- never stored or logged.
--
-- Adds
--   * users                    one row per founder login
--   * accounts.owner_user_id   -> users.id (was Supabase Auth's users table)
--   * disputes.opened_by       -> users.id (was Supabase Auth's users table)
--
-- TODO(email): there is no email provider for auth yet (no verified Resend
-- domain), so there are no magic links, password resets or email
-- verification. `email_verified_at` stays NULL until that ships.
-- =============================================================================

create table public.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null
    check (length(email) between 3 and 254 and email = lower(email) and email like '%_@_%'),
  password_hash      text not null check (password_hash like '$2%'),   -- bcrypt
  email_verified_at  timestamptz,                                       -- see TODO(email) above
  last_sign_in_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index users_email_key on public.users (email);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- Every account belongs to a user; deleting the user deletes their account
-- (and, through the existing cascades, its ledger), as Supabase Auth did.
alter table public.accounts
  add constraint accounts_owner_user_id_fkey
    foreign key (owner_user_id) references public.users (id) on delete cascade;

alter table public.disputes
  add constraint disputes_opened_by_fkey
    foreign key (opened_by) references public.users (id) on delete set null;
