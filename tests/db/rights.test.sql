-- Проверка прав: каждый видит и меняет только свои данные, без входа — ничего.
-- Запуск: tests/db/run.sh (поднимает временный Postgres и применяет все миграции).
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- люди: A и B — два разных аккаунта
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@x.y'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x.y');

create temp table results (name text, ok boolean);
grant all on results to authenticated, anon;

-- выполнить действие от имени человека (или без входа: who = '') и записать, удалось ли
create or replace function pg_temp.try(who text, sql text) returns boolean language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', who, true);
  execute case when who = '' then 'set local role anon' else 'set local role authenticated' end;
  begin execute sql; exception when others then reset role; return false; end;
  reset role; return true;
end $$;
create or replace function pg_temp.expect(name text, actual boolean, expected boolean) returns void language plpgsql as $$
begin insert into results values (name, actual = expected); end $$;
create or replace function pg_temp.rows_as(who text, sql text) returns int language plpgsql as $$
declare c int;
begin
  perform set_config('request.jwt.claim.sub', who, true);
  execute 'set local role authenticated';
  execute 'select count(*) from (' || sql || ') x' into c;
  reset role; return c;
end $$;

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''

begin;
select pg_temp.expect('свой документ: создаётся', pg_temp.try(:A, $q$select doc_set('data/users/00000000-0000-0000-0000-00000000000a/state', '{"data":"{}","updated":1}')$q$), true);
select pg_temp.expect('свой документ: виден', pg_temp.rows_as(:A, $q$select * from docs where path = 'data/users/00000000-0000-0000-0000-00000000000a/state'$q$) = 1, true);
select pg_temp.expect('свой документ: обновляется', pg_temp.try(:A, $q$select doc_update('data/users/00000000-0000-0000-0000-00000000000a/state', '{"updated":2}')$q$), true);
select pg_temp.expect('свой документ: обновление слилось', (select data = '{"data":"{}","updated":2}'::jsonb from docs where path = 'data/users/00000000-0000-0000-0000-00000000000a/state'), true);
select pg_temp.expect('чужой документ: не виден', pg_temp.rows_as(:B, $q$select * from docs$q$) = 0, true);
select pg_temp.expect('чужой документ: не перезаписать', pg_temp.try(:B, $q$select doc_set('data/users/00000000-0000-0000-0000-00000000000a/state', '{"x":1}')$q$), false);
select pg_temp.expect('чужой документ: не обновить', pg_temp.try(:B, $q$select doc_update('data/users/00000000-0000-0000-0000-00000000000a/state', '{"x":1}')$q$), false);
select pg_temp.expect('чужой документ: не удалить', pg_temp.try(:B, $q$select doc_delete('data/users/00000000-0000-0000-0000-00000000000a/state')$q$), false);
select pg_temp.expect('чужой документ: цел', (select data ->> 'updated' = '2' from docs where path = 'data/users/00000000-0000-0000-0000-00000000000a/state'), true);
select pg_temp.expect('запись в таблицу напрямую запрещена', pg_temp.try(:A, $q$insert into docs (path, data) values ('data/users/00000000-0000-0000-0000-00000000000a/x', '{}')$q$), false);
select pg_temp.expect('путь вне data/users запрещён', pg_temp.try(:A, $q$select doc_set('other/00000000-0000-0000-0000-00000000000a/x', '{}')$q$), false);
select pg_temp.expect('корень своей папки запрещён', pg_temp.try(:A, $q$select doc_set('data/users/00000000-0000-0000-0000-00000000000a', '{}')$q$), false);
select pg_temp.expect('слишком большой документ отклонён', pg_temp.try(:A, $q$select doc_set('data/users/00000000-0000-0000-0000-00000000000a/big', jsonb_build_object('s', repeat('a', 2100000)))$q$), false);
select pg_temp.expect('обновление несуществующего -> ошибка', pg_temp.try(:A, $q$select doc_update('data/users/00000000-0000-0000-0000-00000000000a/none', '{}')$q$), false);
select pg_temp.expect('без входа: запись запрещена', pg_temp.try('', $q$select doc_set('data/users/00000000-0000-0000-0000-00000000000a/state', '{}')$q$), false);
select pg_temp.expect('без входа: чтение запрещено', pg_temp.try('', $q$select * from docs$q$), false);
select pg_temp.expect('свой документ: удаляется', pg_temp.try(:A, $q$select doc_delete('data/users/00000000-0000-0000-0000-00000000000a/state')$q$), true);
select pg_temp.expect('после удаления пусто', (select count(*) = 0 from docs), true);
commit;

select case when ok then 'PASS ' else 'FAIL ' end || name from results;
do $$ declare bad int; begin
  select count(*) into bad from results where not ok;
  if bad > 0 then raise exception '% проверок не прошло', bad; end if;
end $$;
