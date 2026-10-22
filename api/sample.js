// Vercel-функция: проксирует запросы помощника к ИИ — Gemini (если задан GEMINI_API_KEY) или Claude (ANTHROPIC_API_KEY).
// Ключи хранятся только в переменных окружения Vercel, в браузер они не попадают.
// Доступ только для вошедших в аккаунт (проверяем токен Supabase) + ограничение числа запросов.

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PROMPT = 60000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 3600000;
const MAX_TOTAL_B64 = 4200000;
const LIMIT_COUNT = 20;               // запросов
const LIMIT_WINDOW = 10 * 60 * 1000;  // за 10 минут на человека (в пределах одного экземпляра функции)
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

function parseJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, fail('method_not_allowed', 'Только POST'));

  const geminiKey = process.env.GEMINI_API_KEY, apiKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !apiKey) return send(res, 500, fail('unavailable', 'На сервере не задан ключ ИИ (GEMINI_API_KEY или ANTHROPIC_API_KEY)'));

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const uid = await whoIs(token);
  if (!uid) return send(res, 401, fail('not_granted', 'Нужно войти в аккаунт'));
  if (limited(uid)) return send(res, 429, fail('rate_limited', 'Слишком много запросов подряд. Подождите несколько минут.'));

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  const mode = b.mode === 'json' ? 'json' : 'text';
  const images = Array.isArray(b.images) ? b.images : [];
  if (!prompt) return send(res, 400, fail('invalid_argument', 'Пустой запрос'));
  if (prompt.length > MAX_PROMPT) return send(res, 413, fail('prompt_too_large', 'Слишком много данных для одного запроса'));
  if (images.length > MAX_IMAGES) return send(res, 400, fail('image_rejected', 'Слишком много изображений'));
  let total = 0;
  for (const im of images) {
    if (!im || !ALLOWED_TYPES.includes(im.media_type) || typeof im.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(im.data) || im.data.length > MAX_IMAGE_B64)
      return send(res, 400, fail('image_rejected', 'Изображение не принято'));
    total += im.data.length;
  }
  if (total > MAX_TOTAL_B64) return send(res, 413, fail('prompt_too_large', 'Слишком большие изображения'));

  const fast = b.modelTier === 'fast';
  const system = mode === 'json' ? 'Отвечай только одним валидным JSON-объектом, без пояснений и без markdown.' : undefined;
  const maxTokens = mode === 'json' ? 4000 : 1500;
  const call = geminiKey
    ? () => askGemini(geminiKey, fast, prompt, images, system, maxTokens, mode)
    : () => askClaude(apiKey, fast, prompt, images, system, maxTokens);

  const out = await call();
  if (out.error) return send(res, out.status, out.error);
  const text = out.text;
  if (mode === 'json') {
    const json = parseJson(text);
    if (!json) return send(res, 422, fail('invalid_json', 'ИИ ответил не в том формате'));
    return send(res, 200, { json });
  }
  return send(res, 200, { text });
};

// ошибка провайдера -> понятный приложению ответ
function providerFail(status, detail) {
  if (status === 429) return { status: 429, error: fail('rate_limited', 'Слишком много запросов подряд. Подождите минуту.') };
  if (status === 413) return { status: 413, error: fail('prompt_too_large', 'Слишком много данных для одного запроса') };
  if (status === 400 && /image/i.test(detail)) return { status: 400, error: fail('image_rejected', 'Изображение не принято') };
  return { status: 502, error: fail('unavailable', 'Не удалось связаться с ИИ. Попробуйте позже.') };
}

async function post(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  try {
    return await fetch(url, { method: 'POST', signal: ctl.signal, headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
const timeoutFail = { status: 502, error: fail('unavailable', 'ИИ не ответил вовремя. Попробуйте ещё раз.') };

async function askGemini(key, fast, prompt, images, system, maxTokens, mode) {
  const model = fast
    ? (process.env.GEMINI_MODEL_FAST || 'gemini-3.5-flash-lite')
    : (process.env.GEMINI_MODEL || 'gemini-3.6-flash');
  const parts = images.map(im => ({ inline_data: { mime_type: im.media_type, data: im.data } }));
  parts.push({ text: prompt });
  const body = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (mode === 'json') body.generationConfig.responseMimeType = 'application/json';
  const r = await post('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { 'x-goog-api-key': key }, body);
  if (!r) return timeoutFail;
  if (!r.ok) {
    let detail = ''; try { detail = (await r.json()).error.message; } catch (e) { /* ничего */ }
    console.error('Gemini error', r.status, detail);
    return providerFail(r.status, detail);
  }
  const data = await r.json();
  const c = (data.candidates || [])[0];
  return { text: ((c && c.content && c.content.parts) || []).map(x => x.text || '').join('') };
}

async function askClaude(key, fast, prompt, images, system, maxTokens) {
  const model = fast
    ? (process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-5-5')
    : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5');

  const content = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } }));
  content.push({ type: 'text', text: prompt });
  const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
  if (!r) return timeoutFail;
  if (!r.ok) {
    let detail = ''; try { detail = (await r.json()).error.message; } catch (e) { /* ничего */ }
    console.error('Anthropic error', r.status, detail);
    return providerFail(r.status, detail);
  }
  const data = await r.json();
  return { text: (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('') };
}
