// Упрощённая имитация Supabase для проверки «переходника»: таблица docs в памяти + функции doc_*.
function makeBackend() {
  const rows = new Map();       // path -> {path,data}
  const put = (path, data) => { rows.set(path, { path, data: JSON.parse(JSON.stringify(data)) }); };
  const self = {
    rows, put, failRpc: null, calls: [],
    client(userId, extra = {}) {
      const session = { access_token: 'tok-' + userId, user: { id: userId, email: userId + '@t.test', user_metadata: extra.meta || {} } };
      const own = p => p.startsWith('data/users/' + userId + '/');
      const from = () => {
        let cols = '*', path = null;
        const b = {
          select(c) { cols = c; return b; },
          eq(col, val) { path = val; return b; },
          maybeSingle() { return b; },
          then(res, rej) {
            const r = rows.get(path);
            const out = r && own(path) ? Object.fromEntries(cols.split(',').map(c => [c, r[c]])) : null;
            return Promise.resolve({ data: out, error: null }).then(res, rej);
          }
        };
        return b;
      };
      const rpc = async (name, a) => {
        self.calls.push(name);
        if (self.failRpc) return { data: null, error: { code: self.failRpc, message: 'boom' } };
        if (!own(a.p_path)) return { data: null, error: { code: '42501', message: 'not_granted' } };
        if (name === 'doc_set') { put(a.p_path, a.p_data); return { data: null, error: null }; }
        if (name === 'doc_update') { const r = rows.get(a.p_path); if (!r) return { data: null, error: { code: 'P0002', message: 'nf' } }; put(a.p_path, { ...r.data, ...a.p_patch }); return { data: null, error: null }; }
        if (name === 'doc_delete') { rows.delete(a.p_path); return { data: null, error: null }; }
        return { data: null, error: { code: 'X', message: 'unknown rpc ' + name } };
      };
      return {
        auth: {
          async getSession() { return { data: { session: extra.noSession ? null : session } }; },
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
          async signOut() {}, async signInWithPassword() { return { error: null }; }, async signUp() { return { data: { session: null }, error: null }; },
          async signInWithOAuth(a) { self.oauthCalls = (self.oauthCalls || []).concat([a]); return { data: {}, error: null }; }
        },
        from, rpc
      };
    }
  };
  return self;
}
module.exports = { makeBackend };
