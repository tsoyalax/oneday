// Vercel-функция: проксирует запросы приложения к Claude (распознавание скриншотов, AI-резюме).
// Ключ ANTHROPIC_API_KEY хранится только в переменных окружения Vercel, в браузер он не попадает.
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return send(res, 500, fail('unavailable', 'На сервере не задан ANTHROPIC_API_KEY'));

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

  const model = b.modelTier === 'fast'
    ? (process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-5-5')
    : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5');

  const content = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } }));
  content.push({ type: 'text', text: prompt });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: mode === 'json' ? 4000 : 1500,
        system: mode === 'json' ? 'Отвечай только одним валидным JSON-объектом, без пояснений и без markdown.' : undefined,
        messages: [{ role: 'user', content }]
      })
    });
  } catch (e) {
    clearTimeout(timer);
    return send(res, 502, fail('unavailable', 'Claude не ответил вовремя. Попробуйте ещё раз.'));
  }
  clearTimeout(timer);

  if (!r.ok) {
    let detail = ''; try { detail = (await r.json()).error.message; } catch (e) { /* ничего */ }
    console.error('Anthropic error', r.status, detail);
    if (r.status === 429) return send(res, 429, fail('rate_limited', 'Слишком много запросов подряд. Подождите минуту.'));
    if (r.status === 413) return send(res, 413, fail('prompt_too_large', 'Слишком много данных для одного запроса'));
    if (r.status === 400 && /image/i.test(detail)) return send(res, 400, fail('image_rejected', 'Изображение не принято'));
    return send(res, 502, fail('unavailable', 'Не удалось связаться с Claude. Попробуйте позже.'));
  }

  const data = await r.json();
  const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
  if (mode === 'json') {
    const json = parseJson(text);
    if (!json) return send(res, 422, fail('invalid_json', 'Claude ответил не в том формате'));
    return send(res, 200, { json });
  }
  return send(res, 200, { text });
};
