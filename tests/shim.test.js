// Проверка «переходника» напрямую: вход, документы, права, помощник, ошибки
const fs = require('fs'), assert = require('assert');
const { JSDOM } = require('jsdom');
const { makeBackend } = require('./fake-supabase');
const shimSrc = fs.readFileSync(__dirname + '/../claude-shim.js', 'utf8');
const cfgTest = "window.OD_CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'sb_publishable_test' };";
let n = 0; const ok = m => { n++; console.log('PASS ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function boot(backend, userId, extra, cfg = cfgTest) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://od.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.supabase = { createClient: () => backend.client(userId, extra) };
  w.eval(cfg); w.eval(shimSrc);
  return w;
}
(async () => {
  const be = makeBackend();
  const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const SA = 'data/users/' + A + '/state';

  // без настроек Supabase переходник не включается: приложение работает локально
  const wl = boot(be, A, {}, "window.OD_CONFIG = { supabaseUrl: '', supabaseKey: '' };");
  assert.equal(wl.claude, undefined); ok('пустой config.js: window.claude нет, приложение локальное');

  const wa = boot(be, A);
  const user = await wa.claude.use('user'), db = await wa.claude.use('db');
  assert.equal(await user.id(), A); assert.equal((await user.me()).id, A); ok('user.id / me');
  assert.equal(await wa.claude.use('nothing'), null); ok('неизвестный модуль -> null');

  // то, что делает приложение: db.doc('data/users/<id>/state').get() / set({data, updated})
  let g = await db.doc(SA).get(); assert.equal(g.exists, false); assert.equal(g.data(), undefined); ok('пустой аккаунт: exists=false');
  await db.doc(SA).set({ data: '{"tasks":[]}', updated: 5 });
  g = await db.doc(SA).get(); assert.equal(g.exists, true); assert.deepEqual(g.data(), { data: '{"tasks":[]}', updated: 5 }); assert.equal(g.id, 'state'); ok('set/get своих данных');
  await db.doc(SA).update({ updated: 6 });
  assert.equal((await db.doc(SA).get()).data().updated, 6); ok('update сливает поля');
  await db.doc('data/users/' + A + '/none').update({ a: 1 }).then(() => assert.fail(), e => assert.equal(e.code, 'not_found')); ok('update несуществующего -> not_found');

  // чужие данные
  const wb = boot(be, B); const dbB = await wb.claude.use('db');
  assert.equal((await dbB.doc(SA).get()).exists, false); ok('чужие данные не видны');
  await dbB.doc(SA).set({ x: 1 }).then(() => assert.fail(), e => assert.equal(e.code, 'not_granted')); ok('чужие данные не перезаписать -> not_granted');

  await db.doc(SA).delete(); assert.equal((await db.doc(SA).get()).exists, false); ok('delete');

  // ошибки базы
  be.failRpc = '54000'; await db.doc(SA).set({}).then(() => assert.fail(), e => assert.equal(e.code, 'quota_exceeded')); ok('54000 -> quota_exceeded');
  be.failRpc = 'PGRST301'; await db.doc(SA).set({}).then(() => assert.fail(), e => assert.equal(e.code, 'revoked')); ok('PGRST301 -> revoked');
  be.failRpc = null;

  // помощник: как в приложении — sample(prompt, {cache:false}) -> {text}
  const sample = await wa.claude.use('sample');
  let sent = null;
  wa.fetch = async (url, o) => { sent = { url, o }; return { ok: true, json: async () => ({ text: '{"plan":[]}' }) }; };
  const res = await sample('prompt', { cache: false });
  assert.equal(res.text, '{"plan":[]}'); assert.equal(sent.url, '/api/sample'); assert.equal(sent.o.headers.Authorization, 'Bearer tok-' + A);
  assert.deepEqual(JSON.parse(sent.o.body), { prompt: 'prompt', mode: 'text', modelTier: 'default' }); ok('sample: запрос с токеном, ответ {text}');
  wa.fetch = async () => ({ ok: false, json: async () => ({ error: { code: 'rate_limited', message: 'm' } }) });
  await sample('p').then(() => assert.fail(), e => assert.equal(e.code, 'rate_limited')); ok('ошибка сервера пробрасывается с кодом');
  wa.fetch = async () => { throw new Error('offline'); };
  await sample('p').then(() => assert.fail(), e => assert.equal(e.code, 'unavailable')); ok('нет сети -> unavailable');
  wa.fetch = async () => ({ ok: true, json: async () => ({ json: { a: 1 } }) });
  assert.deepEqual(await sample.json('p'), { a: 1 }); ok('sample.json');

  // без сессии: экран входа, приложение ждёт
  const wn = boot(be, A, { noSession: true });
  let resolved = false; wn.claude.use('db').then(() => { resolved = true; });
  await wait(100);
  assert.equal(resolved, false); assert.ok(wn.document.querySelector('#odForm')); assert.ok(/OneDay/.test(wn.document.body.textContent)); ok('без входа: экран входа, приложение ждёт');
  assert.equal(wn.document.querySelector('#odGoogle'), null); ok('кнопки Google нет: вход только по почте');

  // выход чистит локальные данные приложения
  wa.localStorage.setItem('journal-ai-v2', 'x'); wa.localStorage.setItem('journal-font', 'f');
  try { await wa.odSignOut(); } catch (e) { /* jsdom не умеет переходить по адресу */ }
  assert.equal(wa.localStorage.getItem('journal-ai-v2'), null); assert.equal(wa.localStorage.getItem('journal-font'), 'f'); ok('выход стирает задачи, оставляет настройки вида');

  console.log(`\nИтого: ${n} проверок прошло`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
