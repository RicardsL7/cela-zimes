// Ceļa Zīmes — kopīgi ziņojumi uz ceļa (F10). Serveris: supabase/reports.sql.
//
//   • „Ziņot” → report_create (vajag kontu; ja tā nav — izveido anonīmo, kā „Kopā”).
//   • Kartē → report_list redzamajam apgabalam (lasīt var arī bez konta).
//   • Pieskaroties ziņojumam → „Vēl ir” / „Vairs nav” (report_vote) vai savam „Dzēst” (report_delete).
// Ziņotāja identitāte netiek atdota — tikai pazīme mine (vai ziņojums ir mans).
// Bez interneta ziņojums NETIEK saglabāts klusi ierīcē — lietotājs redz kļūdu.

const REPORT_REFRESH_MS = 60000;          // apgabala ziņojumus pārlādē ik minūti
const REPORT_AHEAD_M = 500;               // brīdina, ja ziņojums ir priekšā līdz 500 m
const REPORT_HEADING_TOL = 45;            // ziņojuma virziens sakrīt ar manu ±45°
const REPORT_OLD_KEY = 'cz.reports';      // agrākie ziņojumi (tikai šajā ierīcē)

// Servera kļūdu kodi → saprotams teksts
function reportErrorText(code) {
  switch (String(code || '')) {
    case 'rate_limit':     return 'Pārāk daudz ziņojumu — mēģini vēlāk (līdz 10 stundā).';
    case 'vote_limit':     return 'Pārāk daudz atzīmju — mēģini vēlāk.';
    case 'outside_latvia': return 'Ziņot var tikai Latvijā.';
    case 'own_report':     return 'Par savu ziņojumu balsot nevar.';
    case 'not_found':      return 'Šis ziņojums vairs nav aktīvs.';
    case 'bad_type':       return 'Šādu notikumu nevar ziņot.';
    case 'no_location':    return 'Atrašanās vieta vēl nav zināma — pagaidi, kamēr GPS atrod tevi.';
    case 'consent':        return 'Vispirms jāpiekrīt lietošanas noteikumiem.';
    case 'network':        return 'Nav savienojuma — ziņojums netika nosūtīts. Mēģini vēlreiz.';
    case 'no_server':      return 'Serveris nav pieejams.';
    default:               return 'Neizdevās — mēģini vēlreiz.';
  }
}

// Servera rinda → notikums kartei (tāds pats formāts kā AlertStore)
function reportFromRow(row) {
  const t = typeof ALERT_TYPES !== 'undefined' ? ALERT_TYPES[row.type] : null;
  return {
    id: 'rep:' + row.id, rid: row.id, type: row.type, lat: +row.lat, lng: +row.lng,
    heading: row.heading == null ? null : +row.heading, source: 'shared',
    title: t ? t.label : row.type, mine: !!row.mine, myVote: row.my_vote || null, still: +row.still_count || 0,
    createdAt: Date.parse(row.created_at), expiresAt: Date.parse(row.expires_at),
  };
}

function reportAgo(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'tikko';
  if (m < 60) return `pirms ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `pirms ${h} h` + (m % 60 && h < 3 ? ` ${m % 60} min` : '');
  return `pirms ${Math.floor(h / 24)} dienām`;
}
function reportDur(min) {
  if (min >= 2880) return Math.round(min / 1440) + ' dienas';
  if (min >= 60) return String(Math.round(min / 6) / 10).replace('.', ',') + ' h';   // 60 → 1 h, 90 → 1,5 h
  return min + ' min';
}
// Popup teksts
function reportInfo(it, now = Date.now()) {
  const parts = [(it.mine ? 'Tavs ziņojums · ' : 'Ziņots ') + reportAgo(now - it.createdAt)];
  if (it.still) parts.push(`apstiprināja ${it.still}`);
  if (it.myVote === 'still') parts.push('tu atzīmēji „vēl ir”');
  if (it.myVote === 'gone') parts.push('tu atzīmēji „vairs nav”');
  return parts.join(' · ');
}

// Kartes apgabals pieprasījumam: nedaudz plašāks par redzamo, bet ne lielāks par Latviju
function reportBBox(b, pad = 0.25) {
  let { s, w, n, e } = b;
  const dy = (n - s) * pad, dx = (e - w) * pad;
  s = Math.max(55.6, s - dy); n = Math.min(58.1, n + dy);
  w = Math.max(20.9, w - dx); e = Math.min(28.3, e + dx);
  if (s >= n || w >= e) return null;
  return { min_lat: +s.toFixed(4), min_lng: +w.toFixed(4), max_lat: +n.toFixed(4), max_lng: +e.toFixed(4) };
}

// Agrākie (tikai ierīcē saglabātie) ziņojumi, kurus vēl vērts augšupielādēt: aktīvi, ≥ 5 min atlicis, jaunākie 10
function reportsToMigrate(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter(it => it && it.source === 'user' && it.type && isFinite(it.lat) && isFinite(it.lng) &&
      it.expiresAt && it.expiresAt - now >= 5 * 60000)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 10)
    .map(it => ({ type: it.type, lat: it.lat, lng: it.lng, heading: it.heading == null ? null : Math.round(it.heading),
      minutes: Math.round((it.expiresAt - now) / 60000) }));
}

class ReportsApi {
  // auth — CzAuth (auth.js): sesija, url un atslēga
  constructor(auth) { this.auth = auth; }
  async _rpc(name, body, { account = false } = {}) {
    const a = this.auth;
    if (!a) throw Object.assign(new Error('no_server'), { code: 'no_server' });
    let token = null;
    try { token = await a.token({ create: account }); }
    catch (e) { if (account) throw Object.assign(new Error(e.code || 'network'), { code: e.code || 'network' }); }
    if (account && !token) throw Object.assign(new Error('network'), { code: 'network' });
    if (account) a.syncTermsConsent().catch(() => {});
    const headers = { apikey: a.key, 'content-type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let r;
    try { r = await a.fetch(a.url + '/rest/v1/rpc/' + name, { method: 'POST', headers, body: JSON.stringify(body || {}) }); }
    catch { throw Object.assign(new Error('network'), { code: 'network' }); }
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
    if (!r.ok) {
      const m = j && (j.message || j.error) || '';
      const code = /^[a-z_]+$/.test(m) ? m : (r.status >= 500 ? 'network' : 'error');
      throw Object.assign(new Error(code), { code, status: r.status });
    }
    return j;
  }
  create(type, lat, lng, heading, minutes = null) {
    return this._rpc('report_create', { p_type: type, p_lat: lat, p_lng: lng,
      p_heading: heading == null || !isFinite(heading) ? null : Math.round(heading), p_minutes: minutes }, { account: true });
  }
  async list(bbox) { return ((await this._rpc('report_list', bbox)) || []).map(reportFromRow); }
  vote(rid, vote) { return this._rpc('report_vote', { p_id: rid, p_vote: vote }, { account: true }); }
  remove(rid) { return this._rpc('report_delete', { p_id: rid }, { account: true }); }
}

if (typeof module !== 'undefined') {
  module.exports = { ReportsApi, reportErrorText, reportFromRow, reportInfo, reportBBox, reportsToMigrate, reportAgo, reportDur };
}
