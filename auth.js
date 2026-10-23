// Ceļa Zīmes — vienota pieteikšanās (Supabase Auth) kopbraucieniem un ātruma dalīšanai.
//
// Principi (F1):
//   • Atverot lietotni, konts NETIEK veidots. Esoša sesija tiek tikai atjaunota.
//   • Jaunu (anonīmu) kontu izveido tikai pēc lietotāja darbības — atverot „Kopā” vai ieslēdzot
//     ātruma dalīšanu — un tikai tad, ja lietotājs ir piekritis noteikumiem un privātuma politikai.
//   • Anonīmu kontu var „saglabāt” ar e-pastu (Magic Link) vai Google — lietotāja ID nemainās.
//   • Ja e-pasts jau pieder citam kontam: pieslēdzas tam, un anonīmā konta dati tiek pārcelti
//     ar vienreizēju pārcelšanas kodu (SQL funkcijas supabase/rides-7-account.sql).
// Viena sesija visām funkcijām: localStorage "cz.auth.session" (vecās cz.rides.session /
// cz.traffic.session tiek pārņemtas, nevis izmestas).

const CZ_TERMS_VERSION = '2026-10-23';
const CZ_PRIVACY_VERSION = '2026-10-23';
const CZ_AUTH_KEY = 'cz.auth.session';
const CZ_CONSENT_KEY = 'cz.consent';
const CZ_TRANSFER_KEY = 'cz.auth.transfer';

// ---------- Piekrišana noteikumiem ----------
function czConsentGet(storage) {
  try { return JSON.parse(storage.getItem(CZ_CONSENT_KEY) || 'null'); } catch { return null; }
}
function czConsentOk(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const c = storage && czConsentGet(storage);
  return !!(c && c.terms === CZ_TERMS_VERSION && c.privacy === CZ_PRIVACY_VERSION);
}
function czConsentSave(storage) {
  const c = { terms: CZ_TERMS_VERSION, privacy: CZ_PRIVACY_VERSION, at: new Date().toISOString() };
  try { storage.setItem(CZ_CONSENT_KEY, JSON.stringify(c)); } catch { /* */ }
  return c;
}

// JWT saturs (bez pārbaudes — tikai lai zinātu ID / e-pastu; tiesības pārbauda serveris)
function czJwt(token) {
  try {
    const p = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const s = typeof atob === 'function' ? atob(p) : Buffer.from(p, 'base64').toString('binary');
    return JSON.parse(decodeURIComponent(escape(s)));
  } catch { return null; }
}

// Atgriešanās no e-pasta saites / Google: #access_token=…&refresh_token=… vai #error=…
function czParseAuthReturn(hash, search = '') {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const get = k => h.get(k) || q.get(k);
  if (get('error') || get('error_code')) {
    return { error: get('error_code') || get('error'), description: get('error_description') || '' };
  }
  if (h.get('access_token') && h.get('refresh_token')) {
    return { session: { access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: Number(h.get('expires_in')) || 3600 },
      type: h.get('type') || '' };
  }
  if (h.get('message')) return { message: h.get('message') };       // piem. „apstiprini arī otru e-pastu”
  return null;
}

// Saprotams kļūdas teksts (bez API tekstiem)
function czAuthErrorText(code, status) {
  const c = String(code || '');
  if (/otp_expired|expired/.test(c)) return 'Saite vairs nav derīga (tā der 1 stundu un tikai vienu reizi). Pieprasi jaunu saiti.';
  if (/access_denied/.test(c)) return 'Pieslēgšanās tika atcelta vai saite nav derīga. Pamēģini vēlreiz.';
  if (/rate_limit|over_email/.test(c) || status === 429) return 'Pārāk daudz mēģinājumu. Pagaidi dažas minūtes un mēģini vēlreiz.';
  if (/email_exists|already/.test(c)) return 'Šis e-pasts jau pieder citam kontam.';
  if (/identity_already_exists/.test(c)) return 'Šis Google konts jau ir piesaistīts citam kontam.';
  if (/invalid_email|email_address_invalid|validation/.test(c)) return 'E-pasta adrese izskatās nepareiza.';
  if (/not_authorized|address_not_authorized/.test(c)) return 'Uz šo adresi pagaidām nevar nosūtīt e-pastu (lietotne vēl testēšanā).';
  if (/network/.test(c)) return 'Nav interneta savienojuma. Pārbaudi to un mēģini vēlreiz.';
  return 'Neizdevās. Pamēģini vēlreiz vēlāk.';
}
const czEmailOk = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(String(e || '').trim());

class CzAuth {
  constructor(cfg, opts = {}) {
    this.url = cfg.url.replace(/\/$/, ''); this.key = cfg.anonKey;
    this.storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.session = null; this.listeners = new Set(); this._refreshing = null;
    this._load();
  }
  // ---------- Sesija ----------
  _load() {
    const read = k => { try { return JSON.parse(this.storage.getItem(k) || 'null'); } catch { return null; } };
    let s = read(CZ_AUTH_KEY);
    if (!s) {                                   // pāreja no vecajām atsevišķajām sesijām — dati nepazūd
      const r = read('cz.rides.session'), t = read('cz.traffic.session');
      if (r && r.refresh_token) s = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || 0, user_id: r.user_id };
      else if (t && t.refresh) s = { access_token: t.token, refresh_token: t.refresh, expires_at: t.exp || 0, user_id: (czJwt(t.token) || {}).sub || null };
      if (s) this._save(s);
    }
    if (s && s.refresh_token) { this.session = s; this._claims(); }
  }
  _claims() {
    const j = czJwt(this.session && this.session.access_token) || {};
    if (j.sub) this.session.user_id = j.sub;
    this.session.email = j.email || '';
    this.session.anon = j.is_anonymous !== false && !j.email;
  }
  _save(s) { try { this.storage.setItem(CZ_AUTH_KEY, JSON.stringify(s)); } catch { /* */ } }
  _keep(s) {
    this.session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (s.expires_in || 3600) * 1000, user_id: s.user ? s.user.id : null };
    this._claims(); this._save(this.session); this._emit();
  }
  _clear() {
    this.session = null;
    for (const k of [CZ_AUTH_KEY, 'cz.rides.session', 'cz.traffic.session']) { try { this.storage.removeItem(k); } catch { /* */ } }
    this._emit();
  }
  _emit() { for (const f of this.listeners) { try { f(this.session); } catch { /* */ } } }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  get userId() { return this.session ? this.session.user_id : null; }
  get isAnon() { return !!(this.session && this.session.anon); }
  get email() { return this.session ? this.session.email : ''; }
  hasSession() { return !!(this.session && this.session.refresh_token); }

  _h(extra = {}, auth = true) {
    const h = { apikey: this.key, 'content-type': 'application/json', ...extra };
    if (auth && this.session) h.Authorization = 'Bearer ' + this.session.access_token;
    return h;
  }
  async _req(path, { method = 'GET', body, auth = true, query } = {}) {
    let r;
    const q = query ? '?' + new URLSearchParams(query).toString() : '';
    try { r = await this.fetch(this.url + '/auth/v1/' + path + q, { method, headers: this._h({}, auth), body: body ? JSON.stringify(body) : undefined }); }
    catch { const e = new Error('network'); e.code = 'network'; throw e; }
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
    if (!r.ok) { const e = new Error('auth ' + r.status); e.status = r.status; e.code = (j && (j.error_code || j.code || j.error)) || String(r.status); throw e; }
    return j;
  }
  // Derīga piekļuves atslēga. create=true — ja konta nav, izveido anonīmu (tikai ar piekrišanu).
  async token({ create = false } = {}) {
    if (this.session && this.session.expires_at - Date.now() > 60000) return this.session.access_token;
    if (this.session && this.session.refresh_token) {
      if (!this._refreshing) this._refreshing = (async () => {
        try { this._keep(await this._req('token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: this.session.refresh_token } })); }
        catch (e) { if (e.status === 400 || e.status === 401) this._clear(); else throw e; }       // atsaukta sesija — jāpieslēdzas no jauna
        finally { this._refreshing = null; }
      })();
      await this._refreshing;
      if (this.session) return this.session.access_token;
    }
    if (!create) return null;
    if (!czConsentOk(this.storage)) { const e = new Error('consent'); e.code = 'consent'; throw e; }
    this._keep(await this._req('signup', { method: 'POST', auth: false, body: { data: {} } }));   // anonīms konts
    return this.session.access_token;
  }
  async user() { await this.token(); return this.session ? this._req('user') : null; }
  async providers() {
    try { const s = await this._req('settings', { auth: false }); return (s && s.external) || {}; } catch { return {}; }
  }
  // ---------- E-pasts (Magic Link) ----------
  // Anonīmam kontam: piesaista e-pastu (ID nemainās). Citādi: pieslēgšanās saite (konts tiek izveidots, ja vajag).
  async sendLink(email, redirectTo) {
    email = String(email || '').trim().toLowerCase();
    if (!czEmailOk(email)) { const e = new Error('invalid_email'); e.code = 'invalid_email'; throw e; }
    if (this.hasSession() && this.isAnon) {
      await this.token();
      await this._req('user', { method: 'PUT', body: { email }, query: { redirect_to: redirectTo } });
      return { mode: 'link' };
    }
    await this._req('otp', { method: 'POST', auth: false, body: { email, create_user: true, data: {} }, query: { redirect_to: redirectTo } });
    return { mode: 'signin' };
  }
  // Pieslēgties CITAM (esošam) kontam. Ja ir anonīms konts — vispirms sagatavo datu pārcelšanu.
  async signInOther(email, redirectTo) {
    email = String(email || '').trim().toLowerCase();
    if (!czEmailOk(email)) { const e = new Error('invalid_email'); e.code = 'invalid_email'; throw e; }
    await this._prepareTransfer();
    await this._req('otp', { method: 'POST', auth: false, body: { email, create_user: true, data: {} }, query: { redirect_to: redirectTo } });
  }
  async _prepareTransfer() {
    if (!(this.hasSession() && this.isAnon)) return;
    await this.token();
    const r = await this.fetch(this.url + '/rest/v1/rpc/account_transfer_start', { method: 'POST', headers: this._h(), body: '{}' });
    if (!r.ok) throw Object.assign(new Error('transfer'), { code: 'transfer' });
    const code = await r.json();
    try {
      this.storage.setItem(CZ_TRANSFER_KEY, JSON.stringify({ code, from: this.userId, at: Date.now() }));
      this.storage.setItem('cz.auth.prev', JSON.stringify(this.session));     // ja pārcelšana neizdodas — var atgriezties
    } catch { /* */ }
  }
  // Ir iepriekšējais (anonīmais) konts, kura datus neizdevās pārcelt?
  hasPrevious() { try { const p = JSON.parse(this.storage.getItem('cz.auth.prev') || 'null'); return !!(p && p.refresh_token && p.user_id !== this.userId); } catch { return false; } }
  restorePrevious() {
    let p = null; try { p = JSON.parse(this.storage.getItem('cz.auth.prev') || 'null'); } catch { /* */ }
    if (!p || !p.refresh_token) return false;
    this.session = p; this._claims(); this._save(p);
    for (const k of ['cz.auth.prev', CZ_TRANSFER_KEY]) { try { this.storage.removeItem(k); } catch { /* */ } }
    this._emit();
    return true;
  }
  // Nepabeigta pārcelšana (piem. pārtrūka internets) — mēģina vēlreiz
  async claimPending() {
    let t = null; try { t = JSON.parse(this.storage.getItem(CZ_TRANSFER_KEY) || 'null'); } catch { /* */ }
    if (!t || !t.code || !this.hasSession() || this.isAnon || t.from === this.userId) return null;
    await this.token();
    const r = await this.fetch(this.url + '/rest/v1/rpc/account_transfer_claim', { method: 'POST', headers: this._h(), body: JSON.stringify({ code: t.code }) });
    const res = r.ok ? await r.json() : { ok: false, reason: 'error' };
    if (res.ok || res.reason === 'expired') for (const k of [CZ_TRANSFER_KEY, ...(res.ok ? ['cz.auth.prev'] : [])]) { try { this.storage.removeItem(k); } catch { /* */ } }
    return res;
  }
  // ---------- Google ----------
  async oauthUrl(provider, redirectTo, { other = false } = {}) {
    if (this.hasSession() && this.isAnon && !other) {
      await this.token();
      try {
        const j = await this._req('user/identities/authorize', { query: { provider, redirect_to: redirectTo, skip_http_redirect: 'true' } });
        if (j && j.url) return j.url;
      } catch { /* manuālā piesaiste izslēgta — pieslēdzas un pārceļ datus */ }
    }
    if (this.hasSession() && this.isAnon) await this._prepareTransfer();
    return this.url + '/auth/v1/authorize?' + new URLSearchParams({ provider, redirect_to: redirectTo }).toString();
  }
  // ---------- Atgriešanās lietotnē ----------
  // Atgriež { ok, type, transfer: {…} | null, error, message }
  async handleReturn(hash, search) {
    const p = czParseAuthReturn(hash, search);
    if (!p) return null;
    if (p.error) return { ok: false, error: p.error, text: czAuthErrorText(p.error) };
    if (p.message) return { ok: true, message: p.message };
    const before = this.userId;
    this._keep({ ...p.session, user: null });
    let transfer = null;
    let t = null; try { t = JSON.parse(this.storage.getItem(CZ_TRANSFER_KEY) || 'null'); } catch { /* */ }
    if (t && t.code && t.from && t.from !== this.userId && Date.now() - t.at < 2 * 3600e3) {
      try {
        const r = await this.fetch(this.url + '/rest/v1/rpc/account_transfer_claim', { method: 'POST', headers: this._h(), body: JSON.stringify({ code: t.code }) });
        transfer = r.ok ? await r.json() : { ok: false, reason: 'error' };
      } catch { transfer = { ok: false, reason: 'network' }; }
    }
    if (transfer && transfer.ok) for (const k of [CZ_TRANSFER_KEY, 'cz.auth.prev']) { try { this.storage.removeItem(k); } catch { /* */ } }
    return { ok: true, type: p.type, switched: !!before && before !== this.userId, transfer };
  }
  async signOut() {
    try { if (this.session) await this._req('logout', { method: 'POST' }); } catch { /* */ }
    this._clear();
  }
  // Pēc konta dzēšanas — notīra visu lokālo, kas attiecas uz kontu
  forgetLocal() {
    for (const k of [CZ_TRANSFER_KEY, 'cz.rides.seenMsg']) { try { this.storage.removeItem(k); } catch { /* */ } }
    this._clear();
  }
  // Ieraksta piekrišanu serverī (pēc konta izveides) — vienreiz katrai versijai
  async syncConsent(kind, version, accepted = true) {
    if (!this.hasSession()) return;
    const mark = `cz.consent.sent.${kind}`;
    const v = `${this.userId}|${version}|${accepted}`;
    try { if (this.storage.getItem(mark) === v) return; } catch { /* */ }
    await this.token();
    const r = await this.fetch(this.url + '/rest/v1/user_consents', { method: 'POST', headers: this._h({ Prefer: 'return=minimal' }), body: JSON.stringify({ kind, version, accepted }) });
    if (r.ok) { try { this.storage.setItem(mark, v); } catch { /* */ } }
  }
  async syncTermsConsent() {
    if (!czConsentOk(this.storage)) return;
    await this.syncConsent('terms', CZ_TERMS_VERSION);
    await this.syncConsent('privacy', CZ_PRIVACY_VERSION);
  }
}

// ---------- Piekrišanas ekrāns (pirmajā atvēršanā un pēc būtiskām izmaiņām noteikumos) ----------
const czConsentWaiters = [];
function czWhenConsent(fn) {
  if (czConsentOk()) { fn(); return; }
  czConsentWaiters.push(fn);
}
function czConsentGate() {
  const gate = document.getElementById('consentGate');
  if (!gate) return;
  if (czConsentOk()) { gate.hidden = true; return; }
  const prev = czConsentGet(localStorage);
  const upd = document.getElementById('consentUpdated');
  if (upd) upd.hidden = !prev;                      // agrāk piekrita vecākai versijai
  gate.hidden = false;
  document.documentElement.classList.add('consent-open');
  const show = which => { for (const el of gate.querySelectorAll('[data-step]')) el.hidden = el.dataset.step !== which; };
  show('ask');
  gate.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'accept') {
      czConsentSave(localStorage);
      gate.hidden = true;
      document.documentElement.classList.remove('consent-open');
      const a = czAuthGet();
      if (a && a.hasSession()) a.syncTermsConsent().catch(() => {});
      for (const fn of czConsentWaiters.splice(0)) { try { fn(); } catch (e) { console.warn(e); } }
    } else if (b.dataset.act === 'decline') show('declined');
    else if (b.dataset.act === 'back') show('ask');
  });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', czConsentGate); else czConsentGate();
}

// Viena kopīga instance lietotnē
let czAuth = null;
function czAuthGet() {
  if (!czAuth && typeof RIDES_CONFIG !== 'undefined' && RIDES_CONFIG && RIDES_CONFIG.url && RIDES_CONFIG.anonKey) czAuth = new CzAuth(RIDES_CONFIG);
  return czAuth;
}
// Adrese, uz kuru atgriezties no e-pasta / Google (bez ?… un #…)
function czReturnUrl() { return location.origin + location.pathname; }

if (typeof module !== 'undefined') {
  module.exports = { CzAuth, czParseAuthReturn, czAuthErrorText, czConsentOk, czConsentSave, czJwt, czEmailOk, CZ_TERMS_VERSION, CZ_PRIVACY_VERSION };
}
