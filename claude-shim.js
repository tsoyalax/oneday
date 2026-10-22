/*
 * OneDay · claude-shim.js
 *
 * Приложение написано под claude.ai и обращается к window.claude.use('user' | 'db' | 'sample').
 * Этот файл подставляет те же возможности поверх Supabase (вход и база)
 * и серверной функции /api/sample (помощник Claude). Код приложения не меняется.
 */
(function () {
  'use strict';

  var CFG = window.OD_CONFIG || {};
  if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) {
    console.error('OneDay: не заданы настройки Supabase (config.js). Приложение работает только на этом устройстве.');
    return;
  }

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  /* ---------------------------------------------------------------- ошибки */
  function toErr(e) {
    if (!e) return { code: 'unavailable' };
    var c = String(e.code || '');
    if (c === '42501') return { code: 'not_granted', message: 'Нет прав на это действие' };
    if (c === 'P0002') return { code: 'not_found' };
    if (c === '54000') return { code: 'quota_exceeded' };
    if (c === 'PGRST301' || c === 'PGRST303' || e.status === 401) return { code: 'revoked' };
    return { code: 'unavailable', message: e.message };
  }
  async function rpc(name, args) {
    var r = await sb.rpc(name, args);
    if (r.error) throw toErr(r.error);
    return r.data;
  }

  /* ----------------------------------------------------------------- вход */
  var session = null;
  var readyP = null;

  function authErrText(e) {
    var m = String((e && e.message) || '');
    if (/invalid login credentials/i.test(m)) return 'Неверная почта или пароль.';
    if (/already registered|already been registered/i.test(m)) return 'Такой аккаунт уже есть. Нажмите «Войти».';
    if (/at least \d+ characters|password should/i.test(m)) return 'Пароль слишком короткий: нужно не меньше 8 символов.';
    if (/rate limit/i.test(m)) return 'Слишком много попыток. Подождите немного и повторите.';
    if (/email not confirmed/i.test(m)) return 'Почта ещё не подтверждена. Откройте письмо от нас и перейдите по ссылке.';
    if (/valid email|invalid email|unable to validate email/i.test(m)) return 'Проверьте адрес почты.';
    if (/provider is not enabled|unsupported provider/i.test(m)) return 'Вход через Google пока не включён. Войдите по почте и паролю.';
    if (/fetch|network/i.test(m)) return 'Нет связи с сервером. Проверьте интернет.';
    return 'Не получилось войти: ' + m;
  }

  function urlAuthNote() {
    try {
      var h = new URLSearchParams(location.hash.replace(/^#/, ''));
      if (h.get('error_code') === 'otp_expired') {
        history.replaceState(null, '', location.pathname + location.search);
        return 'Ссылка из письма устарела или уже использована. Просто войдите по почте и паролю.';
      }
      if (h.get('error') || new URLSearchParams(location.search).get('error')) {
        history.replaceState(null, '', location.pathname);
        return 'Не получилось войти через Google. Попробуйте ещё раз или войдите по почте и паролю.';
      }
    } catch (e) { /* ничего */ }
    return '';
  }

  function loginScreen(note) {
    return new Promise(function (resolve) {
      var mode = 'in';
      var field = 'padding:11px 12px;font:inherit;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);background:Canvas;color:CanvasText';
      var el = document.createElement('div');
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Вход');
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:16px;' +
        'background:Canvas;color:CanvasText;color-scheme:light dark;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      el.innerHTML =
        '<div style="width:100%;max-width:380px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;padding:24px">' +
        '<h1 style="margin:0 0 4px;font-size:22px">OneDay</h1>' +
        '<p id="odNote" style="margin:0 0 16px;opacity:.75;font-size:14px"></p>' +
        '<button id="odGoogle" type="button" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;' + field + ';font-weight:600;cursor:pointer">' +
        '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>' +
        'Войти через Google</button>' +
        '<p style="display:flex;align-items:center;gap:10px;margin:14px 0;font-size:13px;opacity:.6"><span style="flex:1;height:1px;background:currentColor;opacity:.3"></span>или по почте<span style="flex:1;height:1px;background:currentColor;opacity:.3"></span></p>' +
        '<form id="odForm" style="display:grid;gap:10px">' +
        '<input id="odEmail" type="email" autocomplete="email" required placeholder="Почта" aria-label="Почта" style="' + field + '">' +
        '<input id="odPass" type="password" autocomplete="current-password" required minlength="8" placeholder="Пароль (от 8 символов)" aria-label="Пароль" style="' + field + '">' +
        '<button id="odGo" type="submit" style="padding:11px 12px;font:inherit;font-weight:600;border-radius:8px;border:0;background:#35544a;color:#fff;cursor:pointer">Войти</button>' +
        '</form>' +
        '<p id="odMsg" role="alert" style="min-height:1.4em;margin:10px 0 0;font-size:14px;color:#dc2626"></p>' +
        '<p style="margin:6px 0 0;font-size:14px"><a href="#" id="odSwitch">Нет аккаунта? Создать</a></p>' +
        '</div>';
      document.body.appendChild(el);
      var $ = function (s) { return el.querySelector(s); };
      var msg = function (t, ok) { var m = $('#odMsg'); m.textContent = t || ''; m.style.color = ok ? '#15803d' : '#dc2626'; };
      $('#odNote').textContent = note || 'Войдите, чтобы задачи сохранялись в аккаунте и были на всех устройствах.';
      function paint() {
        $('#odGo').textContent = mode === 'in' ? 'Войти' : 'Создать аккаунт';
        $('#odSwitch').textContent = mode === 'in' ? 'Нет аккаунта? Создать' : 'Уже есть аккаунт? Войти';
        $('#odPass').autocomplete = mode === 'in' ? 'current-password' : 'new-password';
        msg('');
      }
      $('#odSwitch').addEventListener('click', function (e) { e.preventDefault(); mode = mode === 'in' ? 'up' : 'in'; paint(); });
      $('#odGoogle').addEventListener('click', async function () {
        var btn = $('#odGoogle'); btn.disabled = true; msg('');
        try {
          var r = await sb.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } }
          });
          if (r.error) throw r.error;
        } catch (err) { msg(authErrText(err)); btn.disabled = false; }
      });
      var sub = sb.auth.onAuthStateChange(function (ev, s) {
        if (s) { try { sub.data.subscription.unsubscribe(); } catch (e) {} el.remove(); resolve(s); }
      });
      $('#odForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var email = $('#odEmail').value.trim(), password = $('#odPass').value;
        var btn = $('#odGo'); btn.disabled = true; msg('');
        try {
          if (mode === 'in') {
            var r = await sb.auth.signInWithPassword({ email: email, password: password });
            if (r.error) throw r.error;
          } else {
            var u = await sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: location.origin + location.pathname } });
            if (u.error) throw u.error;
            if (!u.data.session) msg('Мы отправили письмо для подтверждения. Перейдите по ссылке из него, затем вернитесь сюда и нажмите «Войти».', true);
          }
        } catch (err) { msg(authErrText(err)); }
        btn.disabled = false;
      });
    });
  }

  function ensureSession() {
    if (readyP) return readyP;
    readyP = (async function () {
      var r = await sb.auth.getSession();
      session = r.data && r.data.session;
      var note = urlAuthNote();
      sb.auth.onAuthStateChange(function (ev, s) {
        session = s;
        if (ev === 'SIGNED_OUT') location.href = location.pathname;
      });
      if (!session) session = await loginScreen(note);
      return session;
    })();
    return readyP;
  }

  // Выход: чистим локальные данные приложения, чтобы следующий человек на этом устройстве их не увидел
  window.odSignOut = async function () {
    try { await sb.auth.signOut(); } catch (e) { /* всё равно выходим */ }
    try {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('journal-ai') === 0) localStorage.removeItem(k); });
    } catch (e) { /* ничего */ }
    location.href = location.pathname;
  };

  /* ------------------------------------------------------------------ user */
  var user = {
    id: async function () { return (await ensureSession()).user.id; },
    me: async function () {
      var u = (await ensureSession()).user, meta = u.user_metadata || {};
      return {
        id: u.id, email: u.email, isOwner: true,
        name: meta.name || meta.full_name || (u.email || '').split('@')[0],
        avatar: meta.avatar_url || meta.picture || ''
      };
    }
  };

  /* -------------------------------------------------------------------- db */
  // Документы по путям data/users/<id>/…; читать и писать можно только свои (права в базе)
  var META = { fromCache: false, hasPendingWrites: false };
  var lastSeg = function (p) { return p.slice(p.lastIndexOf('/') + 1); };
  var clean = function (o) { return JSON.parse(JSON.stringify(o)); };

  function docSnap(path, row) {
    return { id: lastSeg(path), exists: !!row, data: function () { return row ? row.data : undefined; }, metadata: META };
  }

  function docRef(path) {
    return {
      path: path,
      id: lastSeg(path),
      get: async function () {
        var r = await sb.from('docs').select('path,data').eq('path', path).maybeSingle();
        if (r.error) throw toErr(r.error);
        return docSnap(path, r.data);
      },
      set: async function (body) { await rpc('doc_set', { p_path: path, p_data: clean(body) }); },
      update: async function (patch) { await rpc('doc_update', { p_path: path, p_patch: clean(patch) }); },
      delete: async function () { await rpc('doc_delete', { p_path: path }); }
    };
  }

  var store = { doc: function (p) { return docRef(p); } };

  /* ---------------------------------------------------------------- sample */
  async function callSample(payload) {
    await ensureSession();
    var cur = await sb.auth.getSession();
    var token = cur.data && cur.data.session ? cur.data.session.access_token : '';
    var res;
    try {
      res = await fetch('/api/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
    } catch (e) { throw { code: 'unavailable', message: 'Нет связи с сервером. Проверьте интернет.' }; }
    var body = null;
    try { body = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) throw { code: (body && body.error && body.error.code) || 'unavailable', message: body && body.error && body.error.message };
    return body;
  }
  var sample = async function (prompt, opts) {
    opts = opts || {};
    var r = await callSample({ prompt: prompt, mode: 'text', modelTier: opts.modelTier || 'default' });
    if (typeof opts.onText === 'function') { try { opts.onText({ text: r.text }); } catch (e) { /* ничего */ } }
    return { text: r.text };
  };
  sample.json = async function (prompt, opts) {
    opts = opts || {};
    var r = await callSample({ prompt: prompt, mode: 'json', modelTier: opts.modelTier || 'default' });
    return r.json;
  };

  /* ----------------------------------------------------------- точка входа */
  window.claude = {
    use: async function (name) {
      await ensureSession();
      if (name === 'user') return user;
      if (name === 'db') return store;
      if (name === 'sample') return sample;
      return null;
    }
  };
})();
