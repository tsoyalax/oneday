-- =====================================================================
--  OneDay: начальная схема базы (Supabase / Postgres)
--
--  Приложение хранит «документы» по путям вида
--      data/users/<id>/<ключ>        личные данные человека (сейчас один: state)
--  Всё лежит в одной таблице public.docs. Читать можно только свои строки (RLS),
--  а ВСЕ записи идут через функции doc_set / doc_update / doc_delete.
-- =====================================================================

create schema if not exists app_private;
grant usage on schema app_private to authenticated;

-- ---------- таблица документов ----------
create table public.docs (
  path       text primary key
             check (length(path) between 1 and 400
                    and path !~ '//' and path !~ '^/' and path !~ '/$'),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function app_private.docs_before_write() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger docs_before_write before insert or update on public.docs
  for each row execute function app_private.docs_before_write();

-- свой ли это путь: data/users/<мой id>/<что-то>
create or replace function app_private.is_own_path(p_path text) returns boolean
language sql stable as $$
  select auth.uid() is not null
     and split_part(p_path, '/', 1) = 'data'
     and split_part(p_path, '/', 2) = 'users'
     and split_part(p_path, '/', 3) = auth.uid()::text
     and array_length(string_to_array(p_path, '/'), 1) >= 4;
$$;

-- ---------- чтение: только через RLS ----------
alter table public.docs enable row level security;
revoke all on public.docs from public, anon, authenticated;
grant select on public.docs to authenticated;

create policy docs_select on public.docs for select to authenticated
  using (app_private.is_own_path(path));

-- ---------- запись: только через функции ----------
create or replace function public.doc_set(p_path text, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app_private.is_own_path(p_path) then
    raise exception 'not_granted' using errcode = '42501';
  end if;
  if octet_length(p_data::text) > 2000000 then
    raise exception 'too_large' using errcode = '54000';
  end if;
  insert into public.docs (path, data) values (p_path, p_data)
    on conflict (path) do update set data = excluded.data;
end $$;

create or replace function public.doc_update(p_path text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare old jsonb; merged jsonb;
begin
  if not app_private.is_own_path(p_path) then
    raise exception 'not_granted' using errcode = '42501';
  end if;
  select data into old from public.docs where path = p_path for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  merged := old || p_patch;
  if octet_length(merged::text) > 2000000 then
    raise exception 'too_large' using errcode = '54000';
  end if;
  update public.docs set data = merged where path = p_path;
end $$;

create or replace function public.doc_delete(p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app_private.is_own_path(p_path) then
    raise exception 'not_granted' using errcode = '42501';
  end if;
  delete from public.docs where path = p_path;
end $$;

-- ---------- права на функции ----------
revoke all on function public.doc_set(text, jsonb)    from public, anon;
revoke all on function public.doc_update(text, jsonb) from public, anon;
revoke all on function public.doc_delete(text)        from public, anon;
grant execute on function public.doc_set(text, jsonb)    to authenticated;
grant execute on function public.doc_update(text, jsonb) to authenticated;
grant execute on function public.doc_delete(text)        to authenticated;

revoke all on all functions in schema app_private from public, anon;
grant execute on function app_private.is_own_path(text) to authenticated;
