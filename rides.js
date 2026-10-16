// ---------- Kopbraucieni ----------
// Pasažieris publicē "man vajag no A uz B, tad un tad". Šoferis, kurš brauc tajā pusē,
// redz pieprasījumus pa savu maršrutu (vai tuvumā) un piedāvā paņemt. Pasažieris pieņem
// vienu piedāvājumu, tad abi redz viens otra tālruni. Naudu aplikācija neapstrādā.
//
// Datu krātuve: Supabase (kopīga visiem), ja rides-config.js ir iestatīts; citādi demo —
// tikai šajā ierīcē (lai var izmēģināt saskarni). Tīrās funkcijas augšā ir testējamas.

const RIDE_NEAR_ROUTE_M = 800;        // cik tālu no šofera maršruta drīkst būt sākums / galamērķis
const RIDE_MIN_SHARED_M = 300;        // kopīgajam posmam jābūt vismaz tik garam
const RIDE_NEARBY_M = 5000;           // bez maršruta: pasažieri šajā rādiusā
const RIDE_STALE_MS = 30 * 60000;     // pieprasījums pēc izbraukšanas laika vēl redzams 30 min
const RIDE_MAX_AHEAD_MS = 7 * 24 * 3600000;

function rideDist(lat1, lng1, lat2, lng2) {
  const k = 111320, x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * k;
  return Math.hypot(x, y);
}
// Punkta projekcija uz maršruta līnijas (visā garumā, bez blakusefektiem).
function rideProject(route, lat, lng) {
  const { coords, cum } = route;
  const k = 111320, cos = Math.cos(lat * Math.PI / 180);
  let best = { off: Infinity, along: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - lng) * k * cos, ay = (coords[i][1] - lat) * k;
    const bx = (coords[i + 1][0] - lng) * k * cos, by = (coords[i + 1][1] - lat) * k;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, along: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best;
}
// Vai pasažieris der šoferim pa ceļam? fromAlong — cik šoferis jau nobraucis.
// Atgriež { pick, drop, detourM, detourMin } vai null.
function rideMatchRoute(req, route, fromAlong = 0) {
  if (!req || !route || !route.coords || route.coords.length < 2) return null;
  const pick = rideProject(route, req.from_lat, req.from_lng);
  const drop = rideProject(route, req.to_lat, req.to_lng);
  if (pick.off > RIDE_NEAR_ROUTE_M || drop.off > RIDE_NEAR_ROUTE_M) return null;
  if (drop.along - pick.along < RIDE_MIN_SHARED_M) return null;     // jābrauc tajā pašā virzienā
  if (pick.along < fromAlong - 50) return null;                      // jau pabraukts garām
  const detourM = 2 * (pick.off + drop.off);                         // aizbraukt līdz un atpakaļ uz maršrutu
  return { pick: pick.along, drop: drop.along, detourM, detourMin: Math.max(1, Math.round(detourM / 8.3 / 60)) };
}
// Vai pieprasījums vēl aktuāls (nav novecojis)?
function rideIsLive(req, now = Date.now()) {
  if (!req || req.status !== 'open') return false;
  const t = Date.parse(req.depart_at);
  return Number.isFinite(t) && t > now - RIDE_STALE_MS && t < now + RIDE_MAX_AHEAD_MS;
}
// Pieprasījumi šoferim: ar maršrutu — pa ceļam (sakārtoti pēc tā, kurš pirmais), bez — tuvākie.
function rideListForDriver(list, { route = null, along = 0, me = null, myId = null, now = Date.now() } = {}) {
  const out = [];
  for (const r of list || []) {
    if (!rideIsLive(r, now) || (myId && r.user_id === myId)) continue;
    if (route) {
      const m = rideMatchRoute(r, route, along);
      if (m) out.push({ req: r, match: m, sort: m.pick });
    } else if (me) {
      const d = rideDist(me.lat, me.lng, r.from_lat, r.from_lng);
      if (d <= RIDE_NEARBY_M) out.push({ req: r, dist: d, sort: d });
    }
  }
  return out.sort((a, b) => a.sort - b.sort);
}
// Pieprasījuma pārbaude pirms publicēšanas. Atgriež kļūdas tekstu vai null.
function rideValidate(r, now = Date.now()) {
  if (!r) return 'Nav datu.';
  const ok = v => typeof v === 'number' && Number.isFinite(v);
  if (!ok(r.from_lat) || !ok(r.from_lng)) return 'Norādi, no kurienes jābrauc.';
  if (!ok(r.to_lat) || !ok(r.to_lng)) return 'Norādi, uz kurieni jābrauc.';
  if (rideDist(r.from_lat, r.from_lng, r.to_lat, r.to_lng) < 300) return 'Sākums un galamērķis ir pārāk tuvu.';
  const t = Date.parse(r.depart_at);
  if (!Number.isFinite(t)) return 'Norādi izbraukšanas laiku.';
  if (t < now - 15 * 60000) return 'Izbraukšanas laiks jau ir pagājis.';
  if (t > now + RIDE_MAX_AHEAD_MS) return 'Var plānot ne vairāk kā nedēļu uz priekšu.';
  if (!(r.seats >= 1 && r.seats <= 4)) return 'Vietu skaitam jābūt no 1 līdz 4.';
  if ((r.note || '').length > 200) return 'Piezīme ir par garu (līdz 200 zīmēm).';
  return null;
}
function rideProfileValid(p) {
  const name = (p && p.name || '').trim();
  if (name.length < 2) return 'Ieraksti savu vārdu.';
  if (name.length > 40) return 'Vārds ir par garu.';
  const phone = (p.phone || '').replace(/[\s-]/g, '');
  if (phone && !/^\+?\d{7,15}$/.test(phone)) return 'Tālrunis izskatās nepareizs (piem. +371 20000000).';
  return null;
}
// "tagad" · "pēc 20 min" · "šodien 17:30" · "rīt 08:15" · "17.10. 09:00"
function rideTimeText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  if (Math.abs(diff) < 5 * 60000) return 'tagad';
  if (diff > 0 && diff < 60 * 60000) return `pēc ${Math.round(diff / 60000)} min`;
  if (diff < 0 && diff > -60 * 60000) return `pirms ${Math.round(-diff / 60000)} min`;
  const d = new Date(t), n = new Date(now);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dd = Math.round((day(d) - day(n)) / 86400000);
  if (dd === 0) return 'šodien ' + hm;
  if (dd === 1) return 'rīt ' + hm;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${hm}`;
}
function rideDistText(m) { return m < 1000 ? `${Math.round(m / 50) * 50 || 50} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`; }
const RIDE_OFFER_STATUS = { pending: 'Gaida atbildi', accepted: 'Pieņemts', declined: 'Noraidīts', cancelled: 'Atcelts' };

function rideUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}

// ---------- Demo krātuve (tikai šajā ierīcē) ----------
class LocalRideStore {
  constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null), key = 'cz.rides.demo') {
    this.storage = storage; this.key = key; this.demo = true;
    const d = this._load();
    if (!d.me) { d.me = rideUuid(); this._save(d); }
    this.id = d.me;
  }
  _load() {
    try { const v = this.storage && this.storage.getItem(this.key); if (v) return JSON.parse(v); } catch { /* */ }
    return { me: null, profiles: {}, contacts: {}, requests: [], offers: [] };
  }
  _save(d) { try { this.storage && this.storage.setItem(this.key, JSON.stringify(d)); } catch { /* */ } }
  async init() { return true; }
  async profile() { const d = this._load(); const p = d.profiles[this.id]; return p ? { ...p, phone: (d.contacts[this.id] || {}).phone || '' } : null; }
  async saveProfile(p) {
    const d = this._load();
    d.profiles[this.id] = { id: this.id, name: p.name.trim(), car: (p.car || '').trim() };
    d.contacts[this.id] = { id: this.id, phone: (p.phone || '').trim() };
    this._save(d);
  }
  async createRequest(r) {
    const d = this._load();
    const req = { ...r, id: rideUuid(), user_id: r.user_id || this.id, status: 'open', created_at: new Date().toISOString() };
    d.requests.push(req); this._save(d); return req;
  }
  async myRequests() { return this._load().requests.filter(r => r.user_id === this.id && (r.status === 'open' || r.status === 'matched')); }
  async setRequestStatus(id, status) {
    const d = this._load(); const r = d.requests.find(x => x.id === id && x.user_id === this.id);
    if (r) { r.status = status; this._save(d); }
  }
  async openRequests() {
    const d = this._load();
    return d.requests.filter(r => r.status === 'open').map(r => ({ ...r, passenger: d.profiles[r.user_id] || null }));
  }
  async offer(requestId, o) {
    const d = this._load();
    if (d.offers.some(x => x.request_id === requestId && x.driver_id === this.id && x.status !== 'cancelled')) return;
    d.offers.push({ id: rideUuid(), request_id: requestId, driver_id: this.id, eta_min: o.eta_min, note: o.note || '', status: 'pending', created_at: new Date().toISOString() });
    this._save(d);
  }
  async offersFor(requestId) {
    const d = this._load();
    return d.offers.filter(o => o.request_id === requestId && o.status !== 'cancelled').map(o => ({
      ...o, driver: d.profiles[o.driver_id] || null,
      phone: o.status === 'accepted' ? (d.contacts[o.driver_id] || {}).phone || '' : '',
    }));
  }
  async myOffers() {
    const d = this._load();
    return d.offers.filter(o => o.driver_id === this.id && o.status !== 'cancelled').map(o => {
      const req = d.requests.find(r => r.id === o.request_id) || null;
      return { ...o, request: req, passenger: req ? d.profiles[req.user_id] || null : null,
        phone: o.status === 'accepted' && req ? (d.contacts[req.user_id] || {}).phone || '' : '' };
    }).filter(o => o.request && o.request.status !== 'cancelled' && o.request.status !== 'done');
  }
  async respond(offerId, status) {
    const d = this._load(); const o = d.offers.find(x => x.id === offerId);
    if (!o) return;
    const req = d.requests.find(r => r.id === o.request_id);
    if (!req || req.user_id !== this.id) return;
    o.status = status;
    if (status === 'accepted') {
      req.status = 'matched';
      for (const x of d.offers) if (x.request_id === req.id && x.id !== o.id && x.status === 'pending') x.status = 'declined';
    }
    this._save(d);
  }
  async cancelOffer(offerId) {
    const d = this._load(); const o = d.offers.find(x => x.id === offerId && x.driver_id === this.id);
    if (!o) return;
    const req = d.requests.find(r => r.id === o.request_id);
    if (o.status === 'accepted' && req && req.status === 'matched') req.status = 'open';
    o.status = 'cancelled'; this._save(d);
  }
  // Tikai demo: izdomāts pasažieris tuvumā, lai var izmēģināt šofera pusi.
  async addDemoPassenger(near, to) {
    const d = this._load();
    const pid = rideUuid();
    d.profiles[pid] = { id: pid, name: ['Anna', 'Jānis', 'Līga', 'Mārtiņš', 'Ilze'][Math.floor(Math.random() * 5)] + ' (tests)', car: '' };
    d.contacts[pid] = { id: pid, phone: '+371 20000000' };
    this._save(d);
    return this.createRequest({ user_id: pid, from_lat: near.lat, from_lng: near.lng, from_name: near.name || 'Tuvumā',
      to_lat: to.lat, to_lng: to.lng, to_name: to.name || 'Galamērķis', depart_at: new Date(Date.now() + 10 * 60000).toISOString(), seats: 1, note: 'Testa pieprasījums' });
  }
}

// ---------- Supabase krātuve (kopīga visiem lietotājiem) ----------
// Bez papildu bibliotēkām: Supabase Auth (anonīma pieteikšanās) + PostgREST caur fetch.
// Drošību nodrošina datubāzes RLS noteikumi (skat. supabase/rides.sql): katrs var mainīt tikai
// savus ierakstus, un tālruni redz tikai tas, ar kuru brauciens ir saskaņots.
class SupabaseRideStore {
  constructor(cfg, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    this.url = cfg.url.replace(/\/$/, ''); this.key = cfg.anonKey; this.storage = storage;
    this.demo = false; this.session = null; this.id = null;
  }
  _h(extra = {}) {
    return { apikey: this.key, Authorization: 'Bearer ' + (this.session ? this.session.access_token : this.key), 'content-type': 'application/json', ...extra };
  }
  _keep(s) {
    this.session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (s.expires_in || 3600) * 1000, user_id: s.user.id };
    this.id = s.user.id;
    try { this.storage.setItem('cz.rides.session', JSON.stringify(this.session)); } catch { /* */ }
  }
  async init() {
    try { const s = JSON.parse(this.storage.getItem('cz.rides.session') || 'null'); if (s && s.refresh_token) { this.session = s; this.id = s.user_id; } } catch { /* */ }
    await this._ensure();
    return true;
  }
  async _ensure() {
    if (this.session && this.session.expires_at - Date.now() > 60000) return;
    if (this.session && this.session.refresh_token) {
      const r = await fetch(this.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: this._h({ Authorization: 'Bearer ' + this.key }), body: JSON.stringify({ refresh_token: this.session.refresh_token }) });
      if (r.ok) return this._keep(await r.json());
    }
    // Anonīms konts (bez e-pasta/paroles) — Supabase iestatījumos jāieslēdz "Anonymous sign-ins".
    const r = await fetch(this.url + '/auth/v1/signup', { method: 'POST', headers: this._h({ Authorization: 'Bearer ' + this.key }), body: JSON.stringify({ data: {} }) });
    if (!r.ok) throw new Error('Pieteikšanās neizdevās (' + r.status + ')');
    this._keep(await r.json());
  }
  async _rest(path, opts = {}) {
    await this._ensure();
    const r = await fetch(this.url + '/rest/v1/' + path, { ...opts, headers: this._h(opts.headers || {}) });
    if (!r.ok) throw new Error('Datubāze: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.status === 204 ? null : r.json();
  }
  async profile() {
    const [p] = await this._rest(`profiles?id=eq.${this.id}&select=id,name,car`);
    if (!p) return null;
    const [c] = await this._rest(`contacts?id=eq.${this.id}&select=phone`);
    return { ...p, phone: c ? c.phone || '' : '' };
  }
  async saveProfile(p) {
    const up = { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, method: 'POST' };
    await this._rest('profiles', { ...up, body: JSON.stringify({ id: this.id, name: p.name.trim(), car: (p.car || '').trim() }) });
    await this._rest('contacts', { ...up, body: JSON.stringify({ id: this.id, phone: (p.phone || '').trim() }) });
  }
  async createRequest(r) {
    const [req] = await this._rest('ride_requests', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...r, user_id: this.id }) });
    return req;
  }
  async myRequests() { return this._rest(`ride_requests?user_id=eq.${this.id}&status=in.(open,matched)&order=depart_at`); }
  async setRequestStatus(id, status) {
    await this._rest(`ride_requests?id=eq.${id}&user_id=eq.${this.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  }
  async openRequests(box) {
    let q = `ride_requests?status=eq.open&select=*,passenger:profiles(name,car)&order=depart_at&limit=200`;
    q += `&depart_at=gte.${encodeURIComponent(new Date(Date.now() - RIDE_STALE_MS).toISOString())}`;
    if (box) q += `&from_lat=gte.${box.s}&from_lat=lte.${box.n}&from_lng=gte.${box.w}&from_lng=lte.${box.e}`;
    return this._rest(q);
  }
  async offer(requestId, o) {
    await this._rest('ride_offers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ request_id: requestId, driver_id: this.id, eta_min: o.eta_min, note: o.note || '' }) });
  }
  async _phones(ids) {
    if (!ids.length) return {};
    const rows = await this._rest(`contacts?id=in.(${ids.join(',')})&select=id,phone`);   // RLS atdod tikai saskaņotos
    return Object.fromEntries(rows.map(r => [r.id, r.phone || '']));
  }
  async offersFor(requestId) {
    const list = await this._rest(`ride_offers?request_id=eq.${requestId}&status=neq.cancelled&select=*,driver:profiles(name,car)&order=created_at`);
    const ph = await this._phones(list.filter(o => o.status === 'accepted').map(o => o.driver_id));
    return list.map(o => ({ ...o, phone: ph[o.driver_id] || '' }));
  }
  async myOffers() {
    const list = await this._rest(`ride_offers?driver_id=eq.${this.id}&status=neq.cancelled&select=*,request:ride_requests(*,passenger:profiles(name,car))&order=created_at.desc`);
    const ok = list.filter(o => o.request && o.request.status !== 'cancelled' && o.request.status !== 'done');
    const ph = await this._phones(ok.filter(o => o.status === 'accepted').map(o => o.request.user_id));
    return ok.map(o => ({ ...o, passenger: o.request.passenger, phone: ph[o.request.user_id] || '' }));
  }
  async respond(offerId, status) {
    const [o] = await this._rest(`ride_offers?id=eq.${offerId}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status }) });
    if (o && status === 'accepted') {
      await this.setRequestStatus(o.request_id, 'matched');
      await this._rest(`ride_offers?request_id=eq.${o.request_id}&status=eq.pending&id=neq.${offerId}`, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) });
    }
  }
  async cancelOffer(offerId) {
    await this._rest(`ride_offers?id=eq.${offerId}&driver_id=eq.${this.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  }
}

function createRideStore(cfg) {
  if (cfg && cfg.url && cfg.anonKey) return new SupabaseRideStore(cfg);
  return new LocalRideStore();
}

if (typeof module !== 'undefined') {
  module.exports = { rideDist, rideProject, rideMatchRoute, rideIsLive, rideListForDriver, rideValidate, rideProfileValid,
    rideTimeText, rideDistText, LocalRideStore, SupabaseRideStore, createRideStore, RIDE_OFFER_STATUS };
}
