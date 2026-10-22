// Тест серверной функции api/assistant.js (голосовой помощник приложения) с подменой fetch
const assert = require('assert');
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
const handler = require('../api/assistant.js');

let userOk = true, uidReply = 'a1', calls = [], gemini = null;
global.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (String(url).includes('/auth/v1/user')) return userOk ? { ok: true, json: async () => ({ id: uidReply }) } : { ok: false, json: async () => ({}) };
  return { ok: gemini.status === 200, status: gemini.status, json: async () => gemini.body };
};
const reply = (obj) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const mkRes = () => { const r = { headers: {}, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = async (body, auth = 'Bearer tok', method = 'POST') => { const res = mkRes(); await handler({ method, headers: { authorization: auth }, body }, res); return res; };
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); };
const ctx = { today: '2026-10-23', todayIdx: 4, projects: ['Запуск с Викой', 'САС'], regulars: ['Университет'] };

(async () => {
  let r = await call({ text: 'x' }); assert.equal(r.code, 503); assert.equal(r.body.error.code, 'unavailable'); ok('без GEMINI_API_KEY — 503');
  process.env.GEMINI_API_KEY = 'gem-key';

  r = await call({}, 'Bearer tok', 'GET'); assert.equal(r.code, 405); ok('GET отклонён');
  userOk = false; r = await call({ text: 'x' }); assert.equal(r.code, 401); assert.equal(r.body.error.code, 'not_granted'); ok('без входа — 401');
  userOk = true;
  r = await call({ context: ctx }); assert.equal(r.code, 400); ok('нет ни записи, ни текста — 400');
  r = await call({ audio: { mime: 'video/mp4', data: 'AAAA' } }); assert.equal(r.code, 400); assert.equal(r.body.error.code, 'audio_rejected'); ok('чужой тип файла отклонён');
  r = await call({ audio: { mime: 'audio/wav', data: 'не base64!' } }); assert.equal(r.code, 400); ok('мусор вместо base64 отклонён');
  r = await call({ audio: { mime: 'audio/wav', data: 'A'.repeat(4000001) } }); assert.equal(r.code, 413); ok('слишком длинная запись — 413');
  r = await call({ text: 'x'.repeat(8001) }); assert.equal(r.code, 413); ok('слишком длинный текст — 413');

  gemini = reply({
    transcript: 'Позвонить в банк завтра, в среду созвон в 11, каждый вторник зал. Вчера отправил отчёт',
    summary: 'Неделя спокойная',
    tasks: [
      { title: 'Позвонить в банк', mins: 15, day: 5, remind: null, project: null },
      { title: 'Созвон с Викой', mins: 9999, day: 9, remind: '11:00', project: 'запуск с викой' },
      { title: '  ', mins: 10 },
      { title: 'Написать отчёт', mins: 'abc', day: null, remind: '25:99', project: 'Чужой проект' },
    ],
    done: [{ title: 'Отправил отчёт' }, { title: '' }],
    regular: [{ title: 'Зал', days: [1, 1, 8, 3], mins: 90 }, { title: 'Работа', days: [] }],
  });
  calls = [];
  r = await call({ audio: { mime: 'audio/x-wav', data: 'UklGRg==' }, context: ctx });
  assert.equal(r.code, 200);
  const res = r.body.result;
  assert.equal(res.tasks.length, 3); ok('пустые задачи отброшены');
  assert.deepEqual(res.tasks[1], { title: 'Созвон с Викой', mins: 720, day: null, remind: '11:00', project: 'Запуск с Викой' }); ok('минуты и день обрезаны, проект найден без учёта регистра');
  assert.deepEqual(res.tasks[2], { title: 'Написать отчёт', mins: 60, day: null, remind: null, project: null }); ok('неверное время и чужой проект убраны');
  assert.deepEqual(res.done, [{ title: 'Отправил отчёт' }]); ok('сделанное очищено');
  assert.deepEqual(res.regular, [{ title: 'Зал', days: [1, 3], mins: 90 }, { title: 'Работа', days: [0, 1, 2, 3, 4], mins: 60 }]); ok('регулярные: дни без повторов, по умолчанию будни');

  const g = calls.find(c => String(c.url).includes('generativelanguage'));
  const sent = JSON.parse(g.opts.body);
  assert.equal(g.opts.headers['x-goog-api-key'], 'gem-key'); assert.ok(String(g.url).includes('gemini-3.6-flash')); ok('ключ и модель Gemini');
  assert.equal(sent.contents[0].parts[0].inline_data.mime_type, 'audio/wav'); assert.equal(sent.contents[0].parts[0].inline_data.data, 'UklGRg=='); ok('запись уходит в Gemini как audio/wav');
  assert.ok(sent.contents[0].parts[1].text.includes('пятница, 2026-10-23')); assert.ok(sent.contents[0].parts[1].text.includes('Запуск с Викой')); ok('в инструкции — дата и проекты');
  assert.equal(sent.generationConfig.responseMimeType, 'application/json'); assert.ok(sent.generationConfig.responseSchema.properties.tasks); ok('ответ по схеме JSON');
  assert.ok(!JSON.stringify(r.body).includes('gem-key')); ok('ключ не утекает в ответ');

  gemini = reply({ transcript: '', tasks: [], done: [], regular: [] });
  r = await call({ text: 'купить хлеб' }); assert.equal(r.body.result.transcript, 'купить хлеб'); ok('текстовый режим: расшифровка = текст');

  gemini = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'не json' }] } }] } };
  r = await call({ text: 'x' }); assert.equal(r.code, 422); assert.equal(r.body.error.code, 'invalid_json'); ok('не-JSON -> invalid_json');
  gemini = { status: 429, body: { error: { message: 'quota' } } };
  r = await call({ text: 'x' }); assert.equal(r.code, 429); assert.equal(r.body.error.code, 'rate_limited'); ok('429 от Gemini -> rate_limited');
  gemini = { status: 400, body: { error: { message: 'Unsupported audio mime type' } } };
  r = await call({ audio: { mime: 'audio/aac', data: 'AAAA' } }); assert.equal(r.body.error.code, 'audio_rejected'); ok('Gemini не принял запись -> audio_rejected');
  gemini = { status: 500, body: { error: { message: 'boom' } } };
  r = await call({ text: 'x' }); assert.equal(r.code, 502); ok('сбой Gemini -> 502');

  uidReply = 'a2'; gemini = reply({ transcript: 'x', tasks: [], done: [], regular: [] });
  let last; for (let i = 0; i < 20; i++) last = await call({ text: 'x' });
  assert.equal(last.code, 429); ok('лимит запросов на человека работает');

  console.log(`\nВсе ${n} проверок пройдены`);
})().catch((e) => { console.error(e); process.exit(1); });
