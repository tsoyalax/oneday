// Vercel-функция для голосового помощника мобильного приложения OneDay.
// Принимает запись голоса (или текст) и короткий контекст недели, отдаёт её в Gemini
// и возвращает разобранный результат: расшифровку, задачи на неделю, сделанное и регулярные дела.
// Ключ Gemini хранится только в переменных окружения Vercel (GEMINI_API_KEY).
// Доступ только для вошедших в аккаунт (токен Supabase) + ограничение числа запросов.

const AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/mp4', 'audio/m4a'];
const MAX_AUDIO_B64 = 4000000; // ~3 МБ звука: около 90 секунд WAV 16 кГц
const MAX_TEXT = 8000;
const LIMIT_COUNT = 15; // запросов
const LIMIT_WINDOW = 10 * 60 * 1000; // за 10 минут на человека (в пределах одного экземпляра функции)
const buckets = new Map();

const fail = (code, message) => ({ error: { code, message } });
const send = (res, status, body) => { res.status(status).json(body); };

function limited(uid) {
  const now = Date.now();
  const arr = (buckets.get(uid) || []).filter(t => now - t < LIMIT_WINDOW);
  if (arr.length >= LIMIT_COUNT) { buckets.set(uid, arr); return true; }
  arr.push(now); buckets.set(uid, arr); return false;
}

async function whoIs(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !token) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch (e) { return null; }
}

const DAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const str = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const list = (x, n, len) => (Array.isArray(x) ? x : []).map(v => str(v, len)).filter(Boolean).slice(0, n);

// Контекст из приложения: только то, что нужно для разбора, с ограничением длины
function readContext(c) {
  c = c && typeof c === 'object' ? c : {};
  const today = /^\d{4}-\d{2}-\d{2}$/.test(c.today) ? c.today : new Date().toISOString().slice(0, 10);
  const idx = Number.isInteger(c.todayIdx) && c.todayIdx >= 0 && c.todayIdx <= 6 ? c.todayIdx : 0;
  return { today, idx, projects: list(c.projects, 8, 28), regulars: list(c.regulars, 20, 40) };
}

function instructions(ctx) {
  return [
    `Сегодня ${DAYS[ctx.idx]}, ${ctx.today}. Дни недели — индексы: 0 понедельник … 6 воскресенье, сегодня ${ctx.idx}.`,
    'Человек надиктовал свои дела. Сначала дословно расшифруй речь в transcript (на русском, без исправлений по смыслу).',
    'Потом разбери сказанное:',
    '• tasks — разовые дела, которые он собирается сделать на этой неделе. title — коротко, до 8 слов, с глагола («Позвонить в банк»).',
    '  mins — реалистичная оценка времени в минутах вместе с подготовкой (звонок 10–15, письмо 20, документ 60–120, большой отчёт 240+).',
    '  day — индекс дня, ТОЛЬКО если человек сам назвал день или срок («в среду», «завтра», «до пятницы» = 4); иначе null — дни расставит приложение.',
    '  remind — время «ЧЧ:ММ», только если названо точное время дела («созвон в 11», «в 15:30 к врачу»); иначе null.',
    `  project — точное название одного из проектов человека, если дело к нему относится: ${ctx.projects.join('; ') || 'проектов нет'}; иначе null.`,
    '• done — что уже сделано (прошедшее время). Только title.',
    `• regular — то, что повторяется по расписанию («каждый», «по будням», «по вторникам», учёба, зал, работа). title до 4 слов, days — индексы дней, mins — длительность одного раза. Уже известны: ${ctx.regulars.join('; ') || 'нет'} — их не повторяй, если человек не изменил дни.`,
    '• summary — одна короткая дружелюбная фраза о неделе (до 120 символов), без перечисления задач.',
    'Регулярное не попадает в tasks. Ничего не придумывай: если чего-то нет — пустой массив. Если речи нет или она неразборчива — всё пустое и transcript пустой.',
  ].join('\n');
}

// Схема ответа — Gemini обязан вернуть ровно такой JSON
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    summary: { type: 'STRING' },
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          mins: { type: 'INTEGER' },
          day: { type: 'INTEGER', nullable: true },
          remind: { type: 'STRING', nullable: true },
          project: { type: 'STRING', nullable: true },
        },
        required: ['title', 'mins'],
      },
    },
    done: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' } }, required: ['title'] } },
    regular: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, days: { type: 'ARRAY', items: { type: 'INTEGER' } }, mins: { type: 'INTEGER' } },
        required: ['title', 'days'],
      },
    },
  },
  required: ['transcript', 'tasks', 'done', 'regular'],
};

// Ответ ИИ не доверяем: приводим к безопасному виду
function clean(o, ctx) {
  o = o && typeof o === 'object' ? o : {};
  const mins = m => { const n = parseInt(m, 10); return n > 0 ? Math.max(5, Math.min(720, n)) : 60; };
  const day = d => { const n = parseInt(d, 10); return n >= 0 && n <= 6 ? n : null; };
  const time = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? m[1].padStart(2, '0') + ':' + m[2] : null; };
  const proj = p => { const k = str(p, 28).toLowerCase(); return ctx.projects.find(x => x.toLowerCase() === k) || null; };
  const arr = x => (Array.isArray(x) ? x : []);
  return {
    transcript: str(o.transcript, 4000),
    summary: str(o.summary, 160),
    tasks: arr(o.tasks).map(t => ({ title: str(t && t.title, 120), mins: mins(t && t.mins), day: day(t && t.day), remind: time(t && t.remind), project: proj(t && t.project) })).filter(t => t.title).slice(0, 30),
    done: arr(o.done).map(t => ({ title: str(t && t.title, 120) })).filter(t => t.title).slice(0, 20),
    regular: arr(o.regular).map(r => {
      const ds = [...new Set(arr(r && r.days).map(day).filter(d => d != null))].sort();
      return { title: str(r && r.title, 40), days: ds.length ? ds : [0, 1, 2, 3, 4], mins: mins(r && r.mins) };
    }).filter(r => r.title).slice(0, 10),
  };
}

async function askGemini(key, parts) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: 'Ты — помощник планировщика OneDay. Отвечай только JSON по схеме.' }] },
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 4000, temperature: 0.2 },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  let r;
  try {
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    });
  } catch (e) { r = null; } finally { clearTimeout(timer); }
  if (!r) return { status: 502, error: fail('unavailable', 'ИИ не ответил вовремя. Попробуйте ещё раз.') };
  if (!r.ok) {
    let detail = ''; try { detail = (await r.json()).error.message; } catch (e) { /* ничего */ }
    console.error('Gemini error', r.status, detail);
    if (r.status === 429) return { status: 429, error: fail('rate_limited', 'Слишком много запросов подряд. Подождите минуту.') };
    if (r.status === 400 && /audio|mime|inline/i.test(detail)) return { status: 400, error: fail('audio_rejected', 'Запись не принята. Попробуйте ещё раз.') };
    return { status: 502, error: fail('unavailable', 'Не удалось связаться с ИИ. Попробуйте позже.') };
  }
  const data = await r.json();
  const c = (data.candidates || [])[0];
  const text = ((c && c.content && c.content.parts) || []).map(x => x.text || '').join('');
  try { return { json: JSON.parse(text) }; } catch (e) { return { status: 422, error: fail('invalid_json', 'ИИ ответил не в том формате') }; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, fail('method_not_allowed', 'Только POST'));

  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(res, 503, fail('unavailable', 'На сервере не задан ключ Gemini (GEMINI_API_KEY)'));

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const uid = await whoIs(token);
  if (!uid) return send(res, 401, fail('not_granted', 'Нужно войти в аккаунт'));
  if (limited(uid)) return send(res, 429, fail('rate_limited', 'Слишком много запросов подряд. Подождите несколько минут.'));

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const audio = b.audio && typeof b.audio === 'object' ? b.audio : null;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!audio && !text) return send(res, 400, fail('invalid_argument', 'Нет записи и текста'));
  if (text.length > MAX_TEXT) return send(res, 413, fail('prompt_too_large', 'Слишком длинный текст'));
  if (audio) {
    if (!AUDIO_TYPES.includes(audio.mime) || typeof audio.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(audio.data))
      return send(res, 400, fail('audio_rejected', 'Запись не принята'));
    if (audio.data.length > MAX_AUDIO_B64) return send(res, 413, fail('prompt_too_large', 'Запись слишком длинная — до полутора минут'));
  }

  const ctx = readContext(b.context);
  const parts = [];
  if (audio) parts.push({ inline_data: { mime_type: audio.mime === 'audio/x-wav' ? 'audio/wav' : audio.mime, data: audio.data } });
  parts.push({ text: instructions(ctx) + (text ? '\n\nТекст человека (вместо записи):\n<<<\n' + text + '\n>>>' : '\n\nЗапись голоса — во вложении.') });

  const out = await askGemini(key, parts);
  if (out.error) return send(res, out.status, out.error);
  const result = clean(out.json, ctx);
  if (text && !result.transcript) result.transcript = text.slice(0, 4000);
  return send(res, 200, { result });
};
