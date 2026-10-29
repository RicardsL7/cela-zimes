// Ceļa Zīmes — administrēšanas lapa (admin.html). Tikai lietotnes īpašniekam (app_admins, supabase/stats-f16.sql).
// Drošību nodrošina serveris: admin_stats / admin_user_reports / ride-pay 'admin_stats' pārbauda is_app_admin().
// Sesija glabājas atsevišķi ('cz.admin.*'), lai pieslēgšanās šeit nemainītu lietotnes kontu tajā pašā pārlūkā.

const ADM_REASONS = { dangerous_driving: 'Bīstama braukšana', behaviour: 'Neatbilstoša uzvedība', no_show: 'Neieradās',
  payment: 'Problēma ar maksājumu', other: 'Cits' };
const ADM_STATUS = { new: 'Jauns', reviewed: 'Izskatīts', closed: 'Slēgts' };

const admStorage = {
  getItem(k) { try { return localStorage.getItem('cz.admin.' + k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem('cz.admin.' + k, v); } catch { /* */ } },
  removeItem(k) { try { localStorage.removeItem('cz.admin.' + k); } catch { /* */ } },
};
const adm = { auth: null, stats: null, fees: null, reports: null, tab: 'stats', filter: 'all', busy: false, at: null, syncing: false, syncMsg: null };
const $a = id => document.getElementById(id);

function admEl(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function admSay(text, bad = false) {
  const m = $a('admMsg');
  m.textContent = text || ''; m.hidden = !text; m.className = 'adm-msg' + (bad ? ' bad' : '');
}
function admShow(view) {
  for (const [id, v] of [['admLogin', 'login'], ['admDenied', 'denied'], ['admPanel', 'panel']]) $a(id).hidden = view !== v;
  $a('admUser').hidden = !(adm.auth && adm.auth.hasSession() && !adm.auth.isAnon);
  $a('admEmail').textContent = adm.auth && adm.auth.email ? adm.auth.email : '';
  $a('admAvatar').textContent = admInitial(adm.auth && adm.auth.email);
}

// ---------- Serveris ----------
async function admRpc(name, body = {}) {
  const token = await adm.auth.token();
  if (!token) throw Object.assign(new Error('no_session'), { code: 'no_session' });
  const r = await fetch(RIDES_CONFIG.url.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: { apikey: RIDES_CONFIG.anonKey, Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw Object.assign(new Error(/forbidden/.test(t) ? 'forbidden' : 'db ' + r.status), { status: r.status });
  return t ? JSON.parse(t) : null;
}
// F19: „Sinhronizēt ar Stripe” — ride-pay 'sync' (tikai īpašniekam, pārbaude serverī). Pa daļām, līdz viss pārbaudīts.
async function admPay(body) {
  const token = await adm.auth.token();
  const r = await fetch(RIDES_CONFIG.url.replace(/\/$/, '') + '/functions/v1/ride-pay', {
    method: 'POST', headers: { apikey: RIDES_CONFIG.anonKey, Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status });
  return j;
}
function admSyncBlock() {
  const msg = admEl('p', { class: 'adm-sync-msg', role: 'status', hidden: !adm.syncMsg, text: adm.syncMsg ? adm.syncMsg.text : '' });
  if (adm.syncMsg && adm.syncMsg.bad) msg.classList.add('bad');
  const btn = admEl('button', { class: 'adm-act', type: 'button', disabled: adm.syncing || null, onclick: () => admSync(btn, msg) },
    admIcon('undo'), adm.syncing ? 'Sinhronizē…' : 'Sinhronizēt ar Stripe');
  return admEl('div', { class: 'adm-sync' }, btn, msg,
    admEl('p', { class: 'fine', text: 'Salīdzina datubāzē visus vēl neatmaksātos maksājumus ar Stripe un salabo statusu (samaksāts / atmaksāts).' }));
}
async function admSync(btn, msg) {
  if (adm.syncing) return;
  adm.syncing = true; btn.disabled = true; btn.lastChild.textContent = 'Sinhronizē…';
  msg.hidden = false; msg.className = 'adm-sync-msg'; msg.textContent = 'Pārbauda Stripe…';
  let checked = 0, updated = 0, failed = 0, offset = 0;
  try {
    for (let i = 0; i < 50; i++) {
      const j = await admPay({ action: 'sync', offset });
      checked += j.checked || 0; updated += j.updated || 0; failed += j.failed || 0;
      if (!j.more) break;
      offset = j.next;
    }
    adm.syncMsg = { text: `✓ Pārbaudīti ${checked}, atjaunoti ${updated}` + (failed ? ` (${failed} neizdevās — mēģini vēlreiz)` : '') + '.', bad: false };
    adm.syncing = false;
    await admLoad();                                  // pārlādē statistiku (pārzīmē arī šo bloku ar ziņu)
  } catch (e) {
    adm.syncing = false;
    adm.syncMsg = { text: e.status === 403 ? 'Nav piekļuves — sinhronizēt var tikai īpašnieks.'
      : /Nezināma darbība/.test(e.message) ? 'Serverī vēl nav jaunās ride-pay versijas — tā jāizvieto.'
      : 'Sinhronizācija neizdevās: ' + e.message, bad: true };
    msg.className = 'adm-sync-msg bad'; msg.textContent = adm.syncMsg.text;
    btn.disabled = false; btn.lastChild.textContent = 'Sinhronizēt ar Stripe';
  }
}
async function admFees() {
  try {
    const token = await adm.auth.token();
    const r = await fetch(RIDES_CONFIG.url.replace(/\/$/, '') + '/functions/v1/ride-pay', {
      method: 'POST', headers: { apikey: RIDES_CONFIG.anonKey, Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin_stats' }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error || 'Stripe nav pieejams' };
  } catch { return { error: 'Stripe nav pieejams' }; }
}

// ---------- Ielāde ----------
async function admStart() {
  if (typeof RIDES_CONFIG === 'undefined' || !RIDES_CONFIG.url) { admSay('Serveris nav iestatīts.', true); return; }
  adm.auth = new CzAuth(RIDES_CONFIG, { storage: admStorage });
  // Atgriešanās no e-pasta saites
  if (/access_token=|error_code=|[#&?]error=|message=/.test(location.hash + location.search)) {
    let res = null;
    try { res = await adm.auth.handleReturn(location.hash, location.search); } catch { res = { ok: false, text: czAuthErrorText('network') }; }
    history.replaceState(null, '', location.pathname);
    if (res && !res.ok) admSay(res.text || 'Pieslēgšanās neizdevās.', true);
  }
  if (!adm.auth.hasSession() || adm.auth.isAnon) { admShow('login'); return; }
  await admLoad();
}
async function admLoad() {
  if (adm.busy) return;
  adm.busy = true; $a('admRefresh').disabled = true; $a('admRefresh').classList.add('spin');
  if (!adm.stats) admSay('Ielādē…');
  try {
    const ok = await admRpc('is_app_admin');
    if (ok !== true) { admSay(''); admShow('denied'); return; }
    if (!adm.stats) { admSay(''); admShow('panel'); admSkeleton(); }
    const [stats, reports, fees] = await Promise.all([admRpc('admin_stats'), admRpc('admin_user_reports', { lim: 200 }), admFees()]);
    adm.stats = stats; adm.reports = reports || []; adm.fees = fees;
    adm.at = new Date(); admSay(''); admShow('panel'); admRender();
    $a('admUpdated').textContent = 'Atjaunots ' + adm.at.toLocaleTimeString('lv-LV', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    console.warn('Admin', e);
    if (e.code === 'no_session') { admShow('login'); admSay('Sesija beigusies — pieslēdzies vēlreiz.', true); }
    else if (e.message === 'forbidden') { admSay(''); admShow('denied'); }
    else { if (!adm.stats) $a('admStats').replaceChildren(); admSay('Datus neizdevās ielādēt. Pārbaudi internetu un mēģini vēlreiz.', true); }
  } finally { adm.busy = false; $a('admRefresh').disabled = false; $a('admRefresh').classList.remove('spin'); }
}

// ---------- Attēlošana ----------
const admNum = v => (Number(v) || 0).toLocaleString('lv-LV');
const admEur = v => rideMoney(Number(v) || 0);
const admDate = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'; };
const admType = t => (typeof ALERT_TYPES !== 'undefined' && ALERT_TYPES[t] ? ALERT_TYPES[t].label : t);
const admInitial = s => (String(s || '?').trim()[0] || '?').toUpperCase();

// Ikonas (vienkāršas līniju ikonas, savas)
const ADM_ICONS = {
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  active: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  car: '<path d="M5 17h14M4 17v-4l2-5h12l2 5v4"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/><path d="M4 13h16"/>',
  euro: '<path d="M17 6.5A7 7 0 1 0 17 17.5"/><path d="M4 10h9M4 14h9"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  traffic: '<rect x="8" y="2.5" width="8" height="19" rx="3"/><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
  warn: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.2v.3"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
};
function admIcon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ADM_ICONS[name] || '';
  return s;
}

function admRender() {
  for (const b of document.querySelectorAll('.adm-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === adm.tab));
  $a('admStats').hidden = adm.tab !== 'stats'; $a('admReports').hidden = adm.tab !== 'reports';
  const fresh = (adm.reports || []).filter(r => r.status === 'new').length;
  $a('admNewCount').textContent = fresh; $a('admNewCount').hidden = !fresh;
  admRenderStats(); admRenderReports();
}
function admSkeleton() {
  $a('admStats').replaceChildren(
    admEl('div', { class: 'adm-kpis' }, ...Array.from({ length: 6 }, () => admEl('div', { class: 'adm-skel kpi' }))),
    admEl('div', { class: 'adm-grid' }, ...Array.from({ length: 4 }, () => admEl('div', { class: 'adm-skel sec' }))));
}
function admSection(title, icon, tone, rows, extra) {
  const tbl = admEl('table', { class: 'adm-table' },
    admEl('thead', {}, admEl('tr', {}, admEl('th', { text: '' }), admEl('th', { text: 'Šodien' }), admEl('th', { text: 'Mēnesī' }), admEl('th', { text: 'Kopā' }))));
  const body = admEl('tbody');
  for (const r of rows) if (r) body.append(r);
  tbl.append(body);
  return admEl('section', { class: 'card adm-sec ' + tone },
    admEl('div', { class: 'adm-sec-h' }, admEl('span', { class: 'adm-sec-ic' }, admIcon(icon)), admEl('h2', { text: title })),
    admEl('div', { style: 'overflow-x:auto' }, tbl), extra || null);
}
// Viena rinda: nosaukums, šodien, mēnesī, kopā. opts.sub — paskaidrojums, opts.max — joslas mērogs pēc „Kopā”.
function admRow(label, arr, fmt = admNum, opts = {}) {
  const v = i => (arr && arr[i] != null ? Number(arr[i]) : null);
  const first = admEl('td', {}, label, opts.sub ? admEl('span', { class: 'sub', text: opts.sub }) : null);
  if (opts.max) {
    const pct = Math.max(2, Math.round(100 * (v(2) || 0) / opts.max));
    first.append(admEl('span', { class: 'adm-meter' }, admEl('i', { style: `width:${pct}%` })));
  }
  const cell = (i, cls) => {
    const x = v(i);
    return admEl('td', { class: [cls, x === 0 || x == null ? 'zero' : (i === 0 && opts.hot !== false ? 'hot' : '')].filter(Boolean).join(' ') || null,
      text: x == null ? '—' : fmt(x) });
  };
  return admEl('tr', {}, first, cell(0), cell(1), cell(2, 'total'));
}
function admRenderStats() {
  const a = adm.stats, box = $a('admStats');
  box.replaceChildren();
  if (!a) return;
  const u = a.users || {}, f = adm.fees;
  const pct = (f && f.fee_pct) ?? RIDE_FEE_PCT;
  const feeMonth = f && f.fees ? admEur(f.fees.month) : '≈ ' + admEur(Math.round((Number(a.turnover && a.turnover[1]) || 0) * pct / 100));
  // Kopsavilkuma kartītes
  const kpis = [
    ['users', 't-blue', 'Lietotāji kopā', admNum(u.new && u.new[2])],
    ['active', 't-teal', 'Aktīvi šomēnes', admNum(u.active && u.active[1])],
    ['car', 't-green', 'Braucieni šomēnes', admNum(a.done && a.done[1])],
    ['euro', 't-violet', 'Apgrozījums šomēnes', admEur(a.turnover && a.turnover[1])],
    ['coins', 't-amber', 'Komisija šomēnes', feeMonth],
    ['traffic', 't-red', 'Palīdz sastrēgumiem', admNum(a.helpers)],
  ];
  box.append(admEl('div', { class: 'adm-kpis' }, ...kpis.map(([ic, tone, l, v]) =>
    admEl('div', { class: 'adm-kpi ' + tone }, admEl('span', { class: 'adm-kpi-ic' }, admIcon(ic)), admEl('small', { text: l }), admEl('b', { text: v })))));

  const feeRow = f && f.fees
    ? admRow('Komisija' + (f.total_partial ? ' *' : ''), [f.fees.today, f.fees.month, f.fees.total], admEur, { sub: 'Stripe' + (f.test ? ' · testa režīms' : '') })
    : admRow('Komisija', (a.turnover || []).map(v => Math.round((Number(v) || 0) * pct / 100)), admEur, { sub: `aptuveni, ${pct} % no apgrozījuma` });

  const types = Object.keys(a.reports || {}).sort((x, y) => (a.reports[y][2] || 0) - (a.reports[x][2] || 0));
  const maxRep = Math.max(1, ...types.map(t => Number(a.reports[t][2]) || 0));
  const active = Object.entries(a.reports_active || {});
  const activeBox = admEl('div', { class: 'adm-row-active' }, admEl('p', { class: 'fine', style: 'margin:0 0 4px', text: 'Šobrīd kartē aktīvi:' }),
    active.length ? active.map(([t, c]) => admEl('span', { class: 'adm-pill' }, admType(t), ' ', admEl('b', { text: admNum(c) })))
      : admEl('span', { class: 'adm-pill', text: 'nav' }));

  box.append(admEl('div', { class: 'adm-grid' },
    admSection('Lietotāji', 'users', 't-blue', [
      admRow('Jauni konti', u.new), admRow('Aktīvi', u.active, admNum, { sub: 'pieslēdzās' }),
      admRow('Saglabāti konti', u.saved, admNum, { sub: 'e-pasts / Google' }), admRow('Anonīmie', u.anon),
      admRow('Ar „Kopā” profilu', a.profiles)]),
    admSection('Kopbraucieni', 'car', 't-green', [
      admRow('Pieprasījumi', a.requests), admRow('Pabeigti braucieni', a.done), ...(a.cancelled_rides ? [   // F23: tāpat kā „Mana statistika” / „Mani braucieni”
        admRow('Atcelti braucieni', a.cancelled_rides, admNum, { hot: false, sub: 'ar saskaņotu šoferi' }),
        admRow('Atsaukti pieprasījumi', a.withdrawn, admNum, { hot: false, sub: 'neviens nebija pieņēmis' })]
        : [admRow('Atcelti pieprasījumi', a.cancelled, admNum, { hot: false })])]),
    admSection('Kartes maksājumi', 'card', 't-violet', [
      admRow('Apmaksāti braucieni', a.paid), admRow('Apgrozījums', a.turnover, admEur), feeRow,
      admRow('Atmaksāts', a.refunds, admEur, { hot: false })], admSyncBlock()),
    admSection('Ceļa ziņojumi', 'warn', 't-amber', [
      ...types.map(t => admRow(admType(t), a.reports[t], admNum, { max: maxRep })),
      types.length ? null : admEl('tr', {}, admEl('td', { colspan: 4, class: 'zero', text: 'Vēl nav datu.' })),
      admRow('Apstiprinājumi', a.confirms, admNum, { sub: '„vēl ir”' })], activeBox),
    admSection('Radari un sastrēgumi', 'radar', 't-red', [
      admRow('Jauni radari', a.radars && a.radars.new), admRow('Sastrēgumu mērījumi', a.traffic, admNum, { sub: '„Kopā” — pēdējās 28 dienas' })],
      admEl('p', { class: 'fine' }, 'Nederīgi radari: ', admEl('b', { text: admNum(a.radars && a.radars.invalid) })))));

  box.append(admEl('div', { class: 'adm-notes' },
    admEl('p', { class: 'fine', text: `Ceļa ziņojumi un apstiprinājumi skaitīti no ${admDate(a.since)}.` }),
    f && f.fees ? (f.total_partial ? admEl('p', { class: 'fine', text: '* Komisija „Kopā” — pēdējās 2000 maksas.' }) : null)
      : admEl('p', { class: 'fine', text: 'Komisija aprēķināta no apgrozījuma (Stripe dati nav pieejami' + (f && f.error ? ': ' + f.error : '') + ').' })));
}
function admRenderReports() {
  const box = $a('admReports'), all = adm.reports || [];
  const counts = { all: all.length, new: 0, reviewed: 0, closed: 0 };
  for (const r of all) if (counts[r.status] != null) counts[r.status]++;
  const filter = adm.filter || 'all';
  const filters = admEl('div', { class: 'adm-filters' }, ...[['all', 'Visi'], ['new', 'Jauni'], ['reviewed', 'Izskatīti'], ['closed', 'Slēgti']].map(([k, l]) =>
    admEl('button', { class: 'adm-filter', type: 'button', 'aria-pressed': String(filter === k), onclick: () => { adm.filter = k; admRenderReports(); } },
      l, admEl('span', { text: counts[k] }))));
  box.replaceChildren(admEl('div', { class: 'adm-rep-head' },
    admEl('p', { class: 'fine', style: 'margin:0', text: 'Lietotāju „Ziņot par problēmu” pēc braucieniem. Otrs lietotājs ziņojumu neredz.' }), filters));
  const list = filter === 'all' ? all : all.filter(r => r.status === filter);
  if (!list.length) {
    box.append(admEl('div', { class: 'card adm-none' }, admIcon('done'),
      admEl('p', { text: all.length ? 'Šajā sarakstā nekā nav.' : 'Ziņojumu nav — viss kārtībā.' })));
    return;
  }
  for (const r of list) {
    const when = new Date(r.created_at).toLocaleString('lv-LV', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const msg = admEl('p', { class: 'adm-row-msg', hidden: true });
    const actions = admEl('div', { class: 'adm-actions' });
    const setStatus = async st => {
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      try { await admRpc('admin_user_report_set', { p_id: r.id, p_status: st }); r.status = st; admRender(); }
      catch { msg.textContent = 'Neizdevās saglabāt — mēģini vēlreiz.'; msg.hidden = false; for (const b of actions.querySelectorAll('button')) b.disabled = false; }
    };
    const act = (icon, text, st, cls = '') => admEl('button', { class: 'adm-act ' + cls, type: 'button', onclick: () => setStatus(st) }, admIcon(icon), text);
    if (r.status !== 'reviewed') actions.append(act('check', 'Izskatīts', 'reviewed', 'ok'));
    if (r.status !== 'closed') actions.append(act('x', 'Slēgt', 'closed'));
    if (r.status !== 'new') actions.append(act('undo', 'Atpakaļ uz „Jauns”', 'new'));
    const person = (name, role, bad) => admEl('span', { class: 'adm-person' + (bad ? ' bad' : '') },
      admEl('span', { class: 'adm-avatar', text: admInitial(name) }), admEl('span', {}, admEl('small', { text: role }), admEl('b', { text: name || '(dzēsts konts)' })));
    box.append(admEl('article', { class: 'adm-report st-' + r.status },
      admEl('div', { class: 'adm-report-top' },
        admEl('b', { text: ADM_REASONS[r.reason] || r.reason }),
        admEl('span', { class: 'adm-status st-' + r.status, text: ADM_STATUS[r.status] || r.status }),
        admEl('small', { text: when })),
      admEl('div', { class: 'adm-people' },
        person(r.reporter_name, 'Ziņoja'), admEl('span', { class: 'adm-arrow' }, admIcon('arrow')), person(r.reported_name, 'Par', true),
        r.reported_reports > 1 ? admEl('span', { class: 'adm-warn', text: `par šo lietotāju ${r.reported_reports} ziņojumi` }) : null),
      r.details ? admEl('p', { class: 'adm-details', text: '“' + r.details + '”' }) : null,
      actions, msg));
  }
}

// ---------- Notikumi ----------
document.addEventListener('DOMContentLoaded', () => {
  $a('admLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $a('admLoginEmail').value.trim();
    if (!czEmailOk(email)) { admSay('Ieraksti derīgu e-pasta adresi.', true); return; }
    const btn = e.submitter || $a('admLoginForm').querySelector('button'); btn.disabled = true;
    try { await adm.auth.sendLink(email, czReturnUrl()); admSay(`✓ Saite nosūtīta uz ${email}. Atver e-pastu un nospied saiti (tajā pašā pārlūkā).`); }
    catch (err) { admSay(czAuthErrorText(err.code, err.status), true); }
    finally { btn.disabled = false; }
  });
  $a('admRefresh').addEventListener('click', admLoad);
  $a('admSignOut').addEventListener('click', async () => { await adm.auth.signOut(); adm.stats = adm.reports = adm.fees = null; admSay('Tu esi izrakstījies.'); admShow('login'); });
  for (const b of document.querySelectorAll('.adm-tab')) b.addEventListener('click', () => { adm.tab = b.dataset.tab; admRender(); });
  admStart();
});

if (typeof module !== 'undefined') module.exports = { ADM_REASONS, ADM_STATUS, admStorage };
