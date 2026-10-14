-- Shareable developer setup link: /install/<token>.
--
-- A founder sends this link to their developer. The public page shows only the
-- setup instructions and the PUBLISHABLE key (never the signing secret or any
-- dashboard data). The token is random (not derived from the account id) and
-- founders can rotate it, which instantly breaks the old link:
--   update accounts set install_link_token = new_install_link_token() where id = $1
create or replace function public.new_install_link_token()
returns text
language sql
volatile
as $$
  select 'uqi_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

alter table public.accounts
  add column if not exists install_link_token text not null default public.new_install_link_token();

create unique index if not exists accounts_install_link_token_key on public.accounts (install_link_token);
