-- Минимальная заглушка Supabase для проверки миграций в обычном Postgres:
-- роли, схема auth с auth.uid() и таблицей users, публикация для Realtime.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
grant usage on schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table if not exists auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to authenticated, anon;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;

-- хранилище файлов (минимум для проверки правил)
create schema if not exists storage;
grant usage on schema storage to authenticated, anon;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid default auth.uid());
alter table storage.objects enable row level security;
grant select, insert, delete on storage.objects to authenticated;
