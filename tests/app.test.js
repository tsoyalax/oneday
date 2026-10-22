// Приложение целиком в jsdom с имитацией Supabase: загрузка без ошибок, вход, подхват данных из аккаунта, сохранение
const fs = require('fs'), assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeBackend } = require('./fake-supabase');
const root = __dirname + '/..';
const html = fs.readFileSync(root + '/index.html', 'utf8');
const shimSrc = fs.readFileSync(root + '/claude-shim.js', 'utf8');
const cfgTest = "window.OD_CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'sb_publishable_test' };";
let n = 0; const ok = m => { n++; console.log('PASS ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const A = 'aaaaaaaa-0000-0000-0000-000000000001', SA = 'data/users/' + A + '/state';

function boot(be, extra, cfg = cfgTest) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && (e.detail || e.message || e))));
  // подключения из <head> (CDN, config.js, claude-shim.js) jsdom не грузит — подставляем сами
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://od.test/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.supabase = { createClient: () => be.client(A, extra) };
      w.eval(cfg); w.eval(shimSrc);
    }
  });
  return { w: dom.window, errors };
}
(async () => {
  // разметка подключает переходник раньше кода приложения
  const iSb = html.indexOf('supabase-js@'), iCfg = html.indexOf('src="/config.js"'), iShim = html.indexOf('src="/claude-shim.js"'), iApp = html.indexOf('<script>', iShim);
  assert.ok(iSb > 0 && iSb < iCfg && iCfg < iShim && iShim < iApp); ok('порядок скриптов: supabase → config → shim → приложение');
  assert.ok(/supabase-js@\d+\.\d+\.\d+\//.test(html)); ok('supabase-js с точной версией');

  // без настроек: приложение работает локально, без ошибок
  let be = makeBackend();
  let { w, errors } = boot(be, {}, "window.OD_CONFIG = { supabaseUrl: '', supabaseKey: '' };");
  await wait(300);
  assert.deepEqual(errors, []); assert.ok(w.document.querySelector('.tabbar')); ok('без Supabase: загрузка без ошибок');
  assert.equal(be.calls.length, 0); ok('без Supabase: в базу не ходит');

  // без входа: экран входа поверх приложения
  ({ w, errors } = boot(be, { noSession: true }));
  await wait(300);
  assert.deepEqual(errors, []); assert.ok(w.document.querySelector('#odForm')); ok('без входа: экран входа');

  // в аккаунте уже есть данные (с другого устройства) — приложение их подхватывает
  be = makeBackend();
  const remote = { tasks: [{ id: 't1', title: 'Задача из облака', day: 0, status: 'todo' }], projects: [], regulars: [], backlog: [], memory: { log: [] } };
  be.put(SA, { data: JSON.stringify(remote), updated: Date.now() });
  ({ w, errors } = boot(be, {}));
  await wait(600);
  assert.deepEqual(errors, []);
  const local = JSON.parse(w.localStorage.getItem('journal-ai-v2') || '{}');
  assert.ok((local.tasks || []).some(t => t.title === 'Задача из облака')); ok('данные из аккаунта подхвачены и сохранены на устройстве');

  // новый аккаунт, а на устройстве уже есть задачи — они уходят в аккаунт
  be = makeBackend();
  const dom2 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://od.test/', pretendToBeVisual: true,
    beforeParse(x) {
      x.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      x.localStorage.setItem('journal-ai-v2', JSON.stringify(remote));
      x.supabase = { createClient: () => be.client(A, {}) };
      x.eval(cfgTest); x.eval(shimSrc);
    }
  });
  await wait(600);
  const saved = be.rows.get(SA);
  assert.ok(saved && JSON.parse(saved.data.data).tasks.some(t => t.title === 'Задача из облака') && saved.data.updated > 0); ok('локальные задачи отправлены в пустой аккаунт');
  dom2.window.close();

  console.log(`\nИтого: ${n} проверок прошло`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
