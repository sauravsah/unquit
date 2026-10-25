-- Firebase Auth keeps the password and verification state.  The existing UUID
-- remains the internal tenant key used by accounts, ledger entries, and saves.
alter table public.users add column if not exists firebase_uid text;
create unique index if not exists users_firebase_uid_key on public.users (firebase_uid) where firebase_uid is not null;
