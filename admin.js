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
const adm = { auth: null, stats: null, fees: null, reports: null, tab: 'stats', busy: false };
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
  adm.busy = true; $a('admRefresh').disabled = true; admSay('Ielādē…');
  try {
    const ok = await admRpc('is_app_admin');
    if (ok !== true) { admSay(''); admShow('denied'); return; }
    const [stats, reports, fees] = await Promise.all([admRpc('admin_stats'), admRpc('admin_user_reports', { lim: 200 }), admFees()]);
    adm.stats = stats; adm.reports = reports || []; adm.fees = fees;
    admSay(''); admShow('panel'); admRender();
  } catch (e) {
    console.warn('Admin', e);
    if (e.code === 'no_session') { admShow('login'); admSay('Sesija beigusies — pieslēdzies vēlreiz.', true); }
    else if (e.message === 'forbidden') { admSay(''); admShow('denied'); }
    else admSay('Datus neizdevās ielādēt. Pārbaudi internetu un mēģini vēlreiz.', true);
  } finally { adm.busy = false; $a('admRefresh').disabled = false; }
}

// ---------- Attēlošana ----------
const admNum = v => (Number(v) || 0).toLocaleString('lv-LV');
const admEur = v => rideMoney(Number(v) || 0);
const admDate = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'; };
const admType = t => (typeof ALERT_TYPES !== 'undefined' && ALERT_TYPES[t] ? ALERT_TYPES[t].label : t);

function admRender() {
  for (const b of document.querySelectorAll('.adm-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === adm.tab));
  $a('admStats').hidden = adm.tab !== 'stats'; $a('admReports').hidden = adm.tab !== 'reports';
  const fresh = (adm.reports || []).filter(r => r.status === 'new').length;
  $a('admNewCount').textContent = fresh; $a('admNewCount').hidden = !fresh;
  admRenderStats(); admRenderReports();
}
function admRenderStats() {
  const a = adm.stats, box = $a('admStats');
  box.replaceChildren();
  if (!a) return;
  const u = a.users || {}, f = adm.fees;
  // Kopsavilkuma kartītes (šomēnes)
  const tiles = [
    ['Lietotāji kopā', admNum(u.new && u.new[2])], ['Aktīvi šomēnes', admNum(u.active && u.active[1])],
    ['Pabeigti braucieni šomēnes', admNum(a.done && a.done[1])], ['Apgrozījums šomēnes', admEur(a.turnover && a.turnover[1])],
    ['Komisija šomēnes', f && f.fees ? admEur(f.fees.month) : '≈ ' + admEur(Math.round((Number(a.turnover && a.turnover[1]) || 0) * ((f && f.fee_pct) ?? RIDE_FEE_PCT) / 100))],
    ['Šobrīd palīdz sastrēgumiem', admNum(a.helpers)],
  ];
  box.append(admEl('div', { class: 'adm-tiles' }, ...tiles.map(([l, v]) => admEl('div', { class: 'adm-tile' }, admEl('small', { text: l }), admEl('b', { text: v })))));
  const tbl = admEl('table', { class: 'adm-table' });
  tbl.append(admEl('thead', {}, admEl('tr', {}, admEl('th', { text: '' }), admEl('th', { text: 'Šodien' }), admEl('th', { text: 'Šomēnes' }), admEl('th', { text: 'Kopā' }))));
  const body = admEl('tbody');
  const sec = t => body.append(admEl('tr', { class: 'adm-sec' }, admEl('th', { colspan: 4, text: t })));
  const row = (label, arr, fmt = admNum) => body.append(admEl('tr', {}, admEl('td', { text: label }),
    ...[0, 1, 2].map(i => admEl('td', { text: arr && arr[i] != null ? fmt(arr[i]) : '—' }))));
  sec('Lietotāji');
  row('Jauni konti', u.new); row('Aktīvi (pieslēdzās)', u.active); row('Saglabāti konti (e-pasts / Google)', u.saved); row('Anonīmie', u.anon); row('Ar „Kopā” profilu', a.profiles);
  sec('Kopbraucieni');
  row('Pieprasījumi', a.requests); row('Pabeigti braucieni', a.done); row('Atcelti pieprasījumi', a.cancelled);
  sec('Kartes maksājumi');
  row('Apmaksāti braucieni', a.paid); row('Apgrozījums', a.turnover, admEur); row('Atmaksāts', a.refunds, admEur);
  if (f && f.fees) row('Komisija (Stripe' + (f.test ? ', testa režīms' : '') + ')' + (f.total_partial ? ' *' : ''), [f.fees.today, f.fees.month, f.fees.total], admEur);
  else { const pct = (f && f.fee_pct) ?? RIDE_FEE_PCT; row(`Komisija (aptuveni, ${pct} %)`, (a.turnover || []).map(v => Math.round((Number(v) || 0) * pct / 100)), admEur); }
  sec('Ceļa ziņojumi');
  const types = Object.keys(a.reports || {}).sort((x, y) => (a.reports[y][2] || 0) - (a.reports[x][2] || 0));
  for (const t of types) row(admType(t), a.reports[t]);
  if (!types.length) body.append(admEl('tr', {}, admEl('td', { colspan: 4, class: 'fine', text: 'Vēl nav datu.' })));
  row('Apstiprinājumi („vēl ir”)', a.confirms);
  sec('Radari un sastrēgumi');
  row('Jauni radari', a.radars && a.radars.new); row('Sastrēgumu mērījumi', a.traffic);
  tbl.append(body);
  const active = Object.entries(a.reports_active || {}).map(([t, c]) => `${admType(t)}: ${c}`).join(', ');
  box.append(admEl('div', { class: 'adm-scroll' }, tbl),
    admEl('p', { class: 'fine' }, `Šobrīd aktīvi ceļa ziņojumi: ${active || 'nav'}. Nederīgi radari: ${admNum(a.radars && a.radars.invalid)}.`),
    admEl('p', { class: 'fine' }, `Ceļa ziņojumi un apstiprinājumi skaitīti no ${admDate(a.since)}; sastrēgumu mērījumiem „Kopā” — pēdējās 28 dienas.` +
      (f && f.fees ? (f.total_partial ? ' * Komisija „Kopā” — pēdējās 2000 maksas.' : '') : ' Komisija aprēķināta no apgrozījuma (Stripe dati nav pieejami' + (f && f.error ? ': ' + f.error : '') + ').')));
}
function admRenderReports() {
  const box = $a('admReports'), list = adm.reports || [];
  box.replaceChildren(admEl('h2', { text: 'Ziņojumi par lietotājiem' }),
    admEl('p', { class: 'fine', text: 'Lietotāju „Ziņot par problēmu” pēc braucieniem. Otrs lietotājs ziņojumu neredz. Atzīmē, kad izskatīts.' }));
  if (!list.length) { box.append(admEl('p', { class: 'adm-empty', text: 'Ziņojumu nav.' })); return; }
  for (const r of list) {
    const when = new Date(r.created_at).toLocaleString('lv-LV', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const msg = admEl('p', { class: 'adm-row-msg', hidden: true });
    const setStatus = async st => {
      try { await admRpc('admin_user_report_set', { p_id: r.id, p_status: st }); r.status = st; admRender(); }
      catch { msg.textContent = 'Neizdevās saglabāt — mēģini vēlreiz.'; msg.hidden = false; }
    };
    box.append(admEl('article', { class: 'adm-report st-' + r.status },
      admEl('div', { class: 'adm-report-top' },
        admEl('b', { text: ADM_REASONS[r.reason] || r.reason }),
        admEl('span', { class: 'adm-status', text: ADM_STATUS[r.status] || r.status }),
        admEl('small', { text: when })),
      admEl('p', { class: 'adm-who' }, 'Ziņoja: ', admEl('b', { text: r.reporter_name || '(dzēsts konts)' }),
        ' · Par: ', admEl('b', { text: r.reported_name || '(dzēsts konts)' }),
        r.reported_reports > 1 ? admEl('span', { class: 'adm-warn', text: ` · par šo lietotāju ${r.reported_reports} ziņojumi` }) : null),
      r.details ? admEl('p', { class: 'adm-details', text: '“' + r.details + '”' }) : null,
      admEl('div', { class: 'adm-actions' },
        r.status !== 'reviewed' ? admEl('button', { class: 'btn ghost', type: 'button', text: 'Izskatīts', onclick: () => setStatus('reviewed') }) : null,
        r.status !== 'closed' ? admEl('button', { class: 'btn ghost', type: 'button', text: 'Slēgt', onclick: () => setStatus('closed') }) : null,
        r.status !== 'new' ? admEl('button', { class: 'btn ghost', type: 'button', text: 'Atpakaļ uz „Jauns”', onclick: () => setStatus('new') }) : null),
      msg));
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
