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
// Maksa par braucienu: šoferis var norādīt cenu līdz 300 € (tāpat datubāzē: supabase/rides-6-price.sql).
const RIDE_FEE_PCT = 10;
const RIDE_PRICE_MAX = 30000;
function rideFareCapCents(r) { return RIDE_PRICE_MAX; }
// "4,50" / "4.5" / "4" → 450 (centi); tukšs → null; nederīgs → NaN
function rideParsePrice(text) {
  const t = String(text ?? '').trim().replace(/\s|€|eur/gi, '').replace(',', '.');
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}
function rideMoney(c) { return (c / 100).toFixed(2).replace('.', ',') + ' €'; }
function rideSplit(c, pct = RIDE_FEE_PCT) { const fee = Math.round(c * pct / 100); return { fee, driver: c - fee }; }
function rideDistText(m) { return m < 1000 ? `${Math.round(m / 50) * 50 || 50} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`; }
const RIDE_OFFER_STATUS = { pending: 'Gaida atbildi', accepted: 'Pieņemts', declined: 'Noraidīts', cancelled: 'Atcelts' };
// F12: noraidīts piedāvājums šoferim vēl ~10 min redzams ar paskaidrojumu (līdz „Labi”)
const RIDE_DECLINED_SHOW_MS = 10 * 60000;
// Kad noraidīts: datubāzes laiks (responded_at, rides-10-declined.sql) vai brīdis, kad lietotne to pamanīja (firstSeen)
function rideDeclinedAt(o, firstSeen = {}) { return Date.parse(o.responded_at || '') || firstSeen[o.id] || null; }
function rideDeclinedRecent(offers, dismissed = [], firstSeen = {}, now = Date.now()) {
  return (offers || []).filter(o => {
    if (o.status !== 'declined' || dismissed.includes(o.id)) return false;
    const at = rideDeclinedAt(o, firstSeen);
    return at != null && now - at < RIDE_DECLINED_SHOW_MS && now - at > -60000;
  });
}
function rideDeclinedText(o) {
  return o.request && o.request.status === 'cancelled' ? 'Pasažieris atsauca braucienu' : 'Pasažieris izvēlējās citu šoferi';
}

// ---------- Brauciena gaita ----------
// Posms: pending · matched (pieņemts) · coming (šoferis brauc pakaļ) · arrived (ir klāt) · onboard (ceļā) · done
function rideStage(o) {
  if (!o) return null;
  if (o.status !== 'accepted') return o.status;
  return o.trip || 'matched';
}
function rideFresh(at, now = Date.now(), maxMs = 120000) { const t = Date.parse(at); return Number.isFinite(t) && now - t < maxMs; }
// Aptuvenais laiks minūtēs pa pilsētas ceļiem (taisnā līnija × 1,3; ~25 km/h).
function rideEtaMinutes(m) { return Math.max(1, Math.round(m * 1.3 / 7 / 60)); }
// Pasažierim: ko šoferis dara un cik tālu ir.
function ridePassengerStatus(o, req, now = Date.now()) {
  const st = rideStage(o);
  if (st === 'matched') return 'Šoferis drīz dosies pie tevis.';
  if (st === 'coming') {
    if (o.drv_lat != null && rideFresh(o.drv_at, now) && req) {
      const d = rideDist(o.drv_lat, o.drv_lng, req.from_lat, req.from_lng);
      return d < 80 ? 'Šoferis ir gandrīz klāt.' : `Šoferis brauc pie tevis · ${rideDistText(d)} · ~${rideEtaMinutes(d)} min`;
    }
    return 'Šoferis brauc pie tevis.';
  }
  if (st === 'arrived') return 'Šoferis ir klāt! Dodies pie auto.';
  if (st === 'onboard') return 'Ceļā uz galamērķi.';
  if (st === 'done') return 'Brauciens pabeigts.';
  return '';
}
// Šoferim: kur gaida pasažieris.
function rideDriverStatus(o, me, now = Date.now()) {
  const st = rideStage(o), r = o && o.request;
  if (!r) return '';
  const fresh = o.pas_lat != null && rideFresh(o.pas_at, now, 180000);
  const where = fresh ? { lat: o.pas_lat, lng: o.pas_lng } : { lat: r.from_lat, lng: r.from_lng };
  const d = me ? rideDist(me.lat, me.lng, where.lat, where.lng) : null;
  if (st === 'matched') return 'Pasažieris gaida, kad dosies pakaļ.';
  if (st === 'coming') return d == null ? 'Brauc pie pasažiera.' : `Līdz pasažierim ${rideDistText(d)} · ~${rideEtaMinutes(d)} min` + (fresh ? '' : ' (pēc adreses)');
  if (st === 'arrived') return 'Esi klāt — pasažieris nāk.';
  if (st === 'onboard') return 'Ceļā uz galamērķi: ' + (r.to_name || '');
  return '';
}
// Nelasītās ziņas (no otra cilvēka, jaunākas par redzēto).
function rideUnread(msgs, myId, seenId = 0) { return (msgs || []).filter(m => m.id > seenId && m.sender !== myId).length; }
function rideMsgTime(iso) { const d = new Date(iso); return Number.isFinite(d.getTime()) ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''; }

function rideUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}

// ---------- Vērtējumi, ziņošana un vēsture (F13) ----------
const RIDE_REPORT_REASONS = [['dangerous_driving', 'Bīstama braukšana'], ['behaviour', 'Neatbilstoša uzvedība'],
  ['no_show', 'Neieradās'], ['payment', 'Problēma ar maksājumu'], ['other', 'Cits']];
const RIDE_SUMMARY_DAYS = 3;                       // cik dienas pēc brauciena kopsavilkums parādās pats
// „1 brauciens”, „2 braucieni”, „11 braucieni”, „21 brauciens”
function rideCountText(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? ' brauciens' : ' braucieni'); }
// Vidējais vērtējums: „★ 4,7 · 12 braucieni” vai „Vēl nav vērtējumu”
function rideRatingText(sum) {
  if (!sum || !sum.count) return 'Vēl nav vērtējumu' + (sum && sum.rides ? ' · ' + rideCountText(sum.rides) : '');
  return '★ ' + Number(sum.avg).toFixed(1).replace('.', ',') + ' · ' + rideCountText(sum.rides || sum.count);
}
function rideStarsText(n) { return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); }
// Vidējais no zvaigznēm (noapaļots līdz 0,1)
function rideAvg(stars) { return stars.length ? Math.round(stars.reduce((a, b) => a + b, 0) / stars.length * 10) / 10 : null; }
// Datums vēsturei: „26.10. 14:30” (citā gadā — ar gadu)
function rideDateText(iso, now = Date.now()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = x => String(x).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + (d.getFullYear() !== new Date(now).getFullYear() ? d.getFullYear() + '.' : '') + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// Maksājuma statuss kopsavilkumā / vēsturē. live — rides.pay[id] no servera (ja ir), citādi h.pay_status no vēstures.
function ridePayText(h, live) {
  if (!h || !h.price_cents) return '';
  if ((live && live.refunded) || h.pay_status === 'refunded') return '↩ Atmaksāts ' + rideMoney((live && (live.refund_cents || live.amount)) || h.refund_cents || h.price_cents);
  if ((live && live.paid) || h.pay_status === 'paid') return 'Samaksāts ar karti';
  return 'Skaidrā naudā vai nav samaksāts';
}
// Kuriem braucieniem rādīt kopsavilkumu: pabeigts, vēl nav novērtēts un nav aizvērts, ne vecāks par 3 dienām.
function rideSummaryPending(history, seen = [], role = null, now = Date.now()) {
  return (history || []).filter(h => h.status === 'done' && h.offer_id && !h.my_stars && !seen.includes(h.offer_id)
    && (!role || h.role === role) && Date.parse(h.depart_at) > now - RIDE_SUMMARY_DAYS * 86400000);
}
// Kopsavilkuma ieraksts uzreiz pēc „Brauciens pabeigts” (pirms vēsture ielādēta no servera)
function rideHistoryFromOffer(o, req, role, other) {
  return { offer_id: o.id, request_id: req.id, role, status: 'done', trip: 'done', depart_at: req.depart_at,
    from_name: req.from_name, to_name: req.to_name, from_lat: req.from_lat, from_lng: req.from_lng, to_lat: req.to_lat, to_lng: req.to_lng,
    seats: req.seats, price_cents: o.price_cents ?? null, pay_status: null, refund_cents: null,
    other_id: role === 'driver' ? req.user_id : o.driver_id, other_name: (other && other.name) || '', other_car: (other && other.car) || '',
    my_stars: null, my_comment: '', reported: false };
}
function rideRateErr(e) { return /409|23505|duplicate/.test(String(e && (e.code || e.message))) ? 'duplicate' : null; }

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
    d.offers.push({ id: rideUuid(), request_id: requestId, driver_id: this.id, eta_min: o.eta_min, note: o.note || '', price_cents: o.price_cents ?? null, status: 'pending', created_at: new Date().toISOString() });
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
    }).filter(o => o.request && (o.status === 'declined' || (o.request.status !== 'cancelled' && o.request.status !== 'done')));   // F12: noraidītos arī
  }
  async respond(offerId, status) {
    const d = this._load(); const o = d.offers.find(x => x.id === offerId);
    if (!o) return;
    const req = d.requests.find(r => r.id === o.request_id);
    if (!req || req.user_id !== this.id) return;
    o.status = status; o.responded_at = new Date().toISOString();
    if (status === 'accepted') {
      o.was_accepted = true;
      req.status = 'matched';
      for (const x of d.offers) if (x.request_id === req.id && x.id !== o.id && x.status === 'pending') { x.status = 'declined'; x.responded_at = o.responded_at; }
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
  async messages(offerId, afterId = 0) {
    const d = this._load();
    return (d.messages || []).filter(m => m.offer_id === offerId && m.id > afterId);
  }
  async send(offerId, body) {
    const d = this._load(); d.messages = d.messages || [];
    d.messages.push({ id: (d.messages.at(-1) || { id: 0 }).id + 1, offer_id: offerId, sender: this.id, body, created_at: new Date().toISOString() });
    this._save(d);
  }
  async driverUpdate(offerId, u) {
    const d = this._load(); const o = d.offers.find(x => x.id === offerId && x.driver_id === this.id && x.status === 'accepted');
    if (!o) return;
    if (u.trip != null) o.trip = u.trip;
    if (u.lat != null) { o.drv_lat = u.lat; o.drv_lng = u.lng; o.drv_heading = u.heading ?? null; o.drv_at = new Date().toISOString(); }
    if (u.trip === 'done') { const r = d.requests.find(x => x.id === o.request_id); if (r) r.status = 'done'; }
    this._save(d);
  }
  async passengerUpdate(offerId, lat, lng) {
    const d = this._load(); const o = d.offers.find(x => x.id === offerId && x.status === 'accepted');
    if (!o) return;
    o.pas_lat = lat; o.pas_lng = lng; o.pas_at = new Date().toISOString(); this._save(d);
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
  // auth — kopīgā CzAuth instance (auth.js). Testos / otram lietotājam var padot atsevišķu atmiņu.
  constructor(cfg, storage = (typeof localStorage !== 'undefined' ? localStorage : null), auth = null) {
    this.url = cfg.url.replace(/\/$/, ''); this.key = cfg.anonKey; this.storage = storage;
    this.auth = auth || (storage === (typeof localStorage !== 'undefined' ? localStorage : null) && typeof czAuthGet === 'function' ? czAuthGet() : new CzAuth(cfg, { storage }));
    this.demo = false;
  }
  get id() { return this.auth.userId; }
  get session() { return this.auth.session; }
  hasAccount() { return this.auth.hasSession(); }
  // Jaunās "publishable" atslēgas nav JWT — Authorization galveni sūta tikai ar lietotāja sesiju.
  _h(extra = {}) {
    const h = { apikey: this.key, 'content-type': 'application/json', ...extra };
    if (this.session && !('Authorization' in extra)) h.Authorization = 'Bearer ' + this.session.access_token;
    if (h.Authorization === undefined) delete h.Authorization;
    return h;
  }
  // Atverot lietotni: tikai atjauno esošu sesiju — jaunu kontu NEVEIDO.
  async init() {
    if (this.auth.hasSession()) { try { await this.auth.token(); } catch (e) { console.warn('Sesiju neizdevās atjaunot', e); } }
    return true;
  }
  // Konts vajadzīgs (lietotājs atvēra „Kopā”) — izveido anonīmu, ja vēl nav (ar piekrišanu noteikumiem).
  async ensureAccount() {
    await this.auth.token({ create: true });
    try { await this.auth.syncTermsConsent(); } catch { /* nākamreiz */ }
  }
  async _ensure() {
    if (!(await this.auth.token())) throw Object.assign(new Error('Nav konta'), { code: 'no_account' });
  }
  async _rest(path, opts = {}) {
    await this._ensure();
    const r = await fetch(this.url + '/rest/v1/' + path, { ...opts, headers: this._h(opts.headers || {}) });
    const txt = await r.text();
    if (!r.ok) throw new Error('Datubāze: ' + r.status + ' ' + txt.slice(0, 200));
    return txt ? JSON.parse(txt) : null;
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
    await this._rest('ride_offers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ request_id: requestId, driver_id: this.id, eta_min: o.eta_min, note: o.note || '', ...(o.price_cents != null ? { price_cents: o.price_cents } : {}) }) });
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
    const ok = list.filter(o => o.request && (o.status === 'declined' || (o.request.status !== 'cancelled' && o.request.status !== 'done')));   // F12: noraidītos arī
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

// Čats un brauciena gaita (Supabase)
SupabaseRideStore.prototype.messages = function (offerId, afterId = 0) {
  return this._rest(`ride_messages?offer_id=eq.${offerId}&id=gt.${afterId}&order=id&limit=300&select=id,offer_id,sender,body,created_at`);
};
SupabaseRideStore.prototype.send = function (offerId, body) {
  return this._rest('ride_messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ offer_id: offerId, sender: this.id, body }) });
};
SupabaseRideStore.prototype.driverUpdate = function (offerId, u) {
  return this._rest('rpc/ride_driver_update', { method: 'POST', body: JSON.stringify({ oid: offerId, p_trip: u.trip ?? null, p_lat: u.lat ?? null, p_lng: u.lng ?? null, p_heading: u.heading ?? null }) });
};
SupabaseRideStore.prototype.passengerUpdate = function (offerId, lat, lng) {
  return this._rest('rpc/ride_passenger_update', { method: 'POST', body: JSON.stringify({ oid: offerId, p_lat: lat, p_lng: lng }) });
};

// Novecojuši braucieni: datubāze tos atceļ vai pabeidz (supabase/rides-4-expire.sql)
SupabaseRideStore.prototype.expire = function () {
  return this._rest('rpc/ride_expire', { method: 'POST', body: '{}' });
};
LocalRideStore.prototype.expire = async function () { return 0; };
LocalRideStore.prototype.hasAccount = function () { return true; };
LocalRideStore.prototype.ensureAccount = async function () { };
// Konta dzēšana (supabase/rides-7-account.sql → delete_my_account). unclosedAcct — Stripe konts, ko neizdevās slēgt.
SupabaseRideStore.prototype.deleteAccount = function (unclosedAcct = null) {
  return this._rest('rpc/delete_my_account', { method: 'POST', body: JSON.stringify({ p_unclosed_acct: unclosedAcct }) });
};
SupabaseRideStore.prototype.hasDriverAccount = async function () {
  const rows = await this._rest(`driver_accounts?user_id=eq.${this.id}&select=acct`);
  return rows && rows[0] ? rows[0].acct : null;
};

// Kartes maksājumi (servera funkcija supabase/functions/ride-pay). Demo režīmā to nav.
SupabaseRideStore.prototype.pay = async function (action, body = {}) {
  await this._ensure();
  const r = await fetch(this.url + '/functions/v1/ride-pay', { method: 'POST', headers: this._h(), body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Maksājumi pašlaik nav pieejami'); e.status = r.status; throw e; }
  return j;
};

// ---------- Vērtējumi, ziņošana, vēsture (F13; supabase/rides-9-ratings.sql) ----------
SupabaseRideStore.prototype.myHistory = function (limit = 50) {
  return this._rest('rpc/my_ride_history', { method: 'POST', body: JSON.stringify({ lim: limit }) });
};
SupabaseRideStore.prototype.rate = async function (offerId, stars, comment = '') {
  try {
    await this._rest('ride_ratings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ offer_id: offerId, stars, comment: String(comment || '').trim().slice(0, 200) }) });
  } catch (e) { if (rideRateErr(e)) e.code = 'duplicate'; throw e; }
};
SupabaseRideStore.prototype.myRatings = async function (ids) {
  if (!ids || !ids.length) return {};
  const rows = await this._rest(`ride_ratings?offer_id=in.(${ids.join(',')})&rater_id=eq.${this.id}&select=offer_id,stars,comment`);
  return Object.fromEntries((rows || []).map(r => [r.offer_id, { stars: r.stars, comment: r.comment }]));
};
SupabaseRideStore.prototype.myRating = async function (offerId) { return (await this.myRatings([offerId]))[offerId] || null; };
SupabaseRideStore.prototype.ratingSummary = async function (userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))].slice(0, 100);
  if (!ids.length) return {};
  const rows = await this._rest('rpc/rating_summary', { method: 'POST', body: JSON.stringify({ ids }) });
  return Object.fromEntries((rows || []).map(r => [r.user_id, { avg: r.avg != null ? Number(r.avg) : null, count: r.count || 0, rides: r.rides || 0 }]));
};
SupabaseRideStore.prototype.reportUser = function (offerId, reason, details = '') {
  return this._rest('user_reports', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ offer_id: offerId, reason, details: String(details || '').trim().slice(0, 500) }) });
};

// Demo krātuve: tie paši noteikumi kā datubāzē
LocalRideStore.prototype._ride = function (d, offerId) {
  const o = d.offers.find(x => x.id === offerId);
  const r = o && d.requests.find(x => x.id === o.request_id);
  if (!o || !r) throw new Error('Brauciens nav atrasts');
  const other = o.driver_id === this.id ? r.user_id : r.user_id === this.id ? o.driver_id : null;
  if (!other) throw new Error('Tu nebiji šī brauciena dalībnieks');
  return { o, r, other };
};
LocalRideStore.prototype.myHistory = async function (limit = 50) {
  const d = this._load(), me = this.id, out = [];
  const ratings = d.ratings || [], reports = d.reports || [];
  for (const o of d.offers) {
    const r = d.requests.find(x => x.id === o.request_id);
    if (!r || !(o.was_accepted || o.status === 'accepted') || (o.driver_id !== me && r.user_id !== me)) continue;
    const done = o.status === 'accepted' && o.trip === 'done';
    if (!(done || o.status === 'cancelled' || r.status === 'cancelled' || r.status === 'done')) continue;
    const role = o.driver_id === me ? 'driver' : 'passenger';
    const other = role === 'driver' ? r.user_id : o.driver_id, p = d.profiles[other] || {};
    const mine = ratings.find(x => x.offer_id === o.id && x.rater_id === me);
    out.push({ offer_id: o.id, request_id: r.id, role, status: done ? 'done' : 'cancelled', trip: o.trip || '', depart_at: r.depart_at,
      from_name: r.from_name, to_name: r.to_name, from_lat: r.from_lat, from_lng: r.from_lng, to_lat: r.to_lat, to_lng: r.to_lng, seats: r.seats,
      price_cents: o.price_cents ?? null, pay_status: null, refund_cents: null, other_id: other, other_name: p.name || '', other_car: p.car || '',
      my_stars: mine ? mine.stars : null, my_comment: mine ? mine.comment : null, reported: reports.some(x => x.offer_id === o.id && x.reporter_id === me) });
  }
  for (const r of d.requests) {
    if (r.user_id !== me || r.status !== 'cancelled' || d.offers.some(o => o.request_id === r.id && (o.was_accepted || o.status === 'accepted'))) continue;
    out.push({ offer_id: null, request_id: r.id, role: 'passenger', status: 'cancelled', trip: '', depart_at: r.depart_at, from_name: r.from_name, to_name: r.to_name,
      from_lat: r.from_lat, from_lng: r.from_lng, to_lat: r.to_lat, to_lng: r.to_lng, seats: r.seats, price_cents: null, pay_status: null, refund_cents: null,
      other_id: null, other_name: null, other_car: null, my_stars: null, my_comment: null, reported: false });
  }
  return out.sort((a, b) => Date.parse(b.depart_at) - Date.parse(a.depart_at)).slice(0, limit);
};
LocalRideStore.prototype.rate = async function (offerId, stars, comment = '') {
  const d = this._load(); d.ratings = d.ratings || [];
  const { o, other } = this._ride(d, offerId);
  if (!(o.status === 'accepted' && o.trip === 'done')) throw new Error('Novērtēt var tikai pabeigtu braucienu');
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('Vērtējums ir no 1 līdz 5');
  if (d.ratings.some(x => x.offer_id === offerId && x.rater_id === this.id)) throw Object.assign(new Error('Tu jau novērtēji šo braucienu'), { code: 'duplicate' });
  d.ratings.push({ id: d.ratings.length + 1, offer_id: offerId, rater_id: this.id, rated_id: other, stars, comment: String(comment || '').trim().slice(0, 200), created_at: new Date().toISOString() });
  this._save(d);
};
LocalRideStore.prototype.myRatings = async function (ids) {
  const out = {};
  for (const x of this._load().ratings || []) if (x.rater_id === this.id && ids.includes(x.offer_id)) out[x.offer_id] = { stars: x.stars, comment: x.comment };
  return out;
};
LocalRideStore.prototype.myRating = async function (offerId) { return (await this.myRatings([offerId]))[offerId] || null; };
LocalRideStore.prototype.ratingSummary = async function (userIds) {
  const d = this._load(), out = {};
  for (const id of new Set((userIds || []).filter(Boolean))) {
    const stars = (d.ratings || []).filter(x => x.rated_id === id).map(x => x.stars);
    const rides = d.offers.filter(o => o.status === 'accepted' && o.trip === 'done' && (o.driver_id === id || (d.requests.find(r => r.id === o.request_id) || {}).user_id === id)).length;
    out[id] = { avg: rideAvg(stars), count: stars.length, rides };
  }
  return out;
};
LocalRideStore.prototype.reportUser = async function (offerId, reason, details = '') {
  const d = this._load(); d.reports = d.reports || [];
  const { o, r, other } = this._ride(d, offerId);
  if (!((o.status === 'accepted' && (o.trip === 'done' || r.status === 'cancelled')) || o.status === 'cancelled')) throw new Error('Ziņot var par pabeigtu vai atceltu braucienu');
  if (!RIDE_REPORT_REASONS.some(([k]) => k === reason)) throw new Error('Izvēlies iemeslu');
  if (d.reports.filter(x => x.reporter_id === this.id && Date.parse(x.created_at) > Date.now() - 86400000).length >= 10) throw new Error('Pārāk daudz ziņojumu — mēģini rīt');
  d.reports.push({ id: d.reports.length + 1, offer_id: offerId, reporter_id: this.id, reported_id: other, reason, details: String(details || '').trim().slice(0, 500), status: 'new', created_at: new Date().toISOString() });
  this._save(d);
};

function createRideStore(cfg) {
  if (cfg && cfg.url && cfg.anonKey) return new SupabaseRideStore(cfg);
  return new LocalRideStore();
}

if (typeof module !== 'undefined') {
  module.exports = { rideFareCapCents, rideParsePrice, rideMoney, rideSplit, RIDE_FEE_PCT, rideDist, rideProject, rideMatchRoute, rideIsLive, rideListForDriver, rideValidate, rideProfileValid,
    rideTimeText, rideDistText, rideStage, rideFresh, rideEtaMinutes, ridePassengerStatus, rideDriverStatus, rideUnread, rideMsgTime, RIDE_DECLINED_SHOW_MS, rideDeclinedAt, rideDeclinedRecent, rideDeclinedText, RIDE_REPORT_REASONS, rideCountText, rideRatingText, rideStarsText, rideAvg, rideDateText, ridePayText, rideSummaryPending, rideHistoryFromOffer, rideRateErr, LocalRideStore, SupabaseRideStore, createRideStore, RIDE_OFFER_STATUS };
}
