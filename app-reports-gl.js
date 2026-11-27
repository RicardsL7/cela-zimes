// Ceļa Zīmes — ziņošana, kopīgi ziņojumi (F10), „Vai policija vēl ir šeit?”.
// B16 (audits 2): pārcelts no app-gl.js bez izmaiņām (tas pats globālais tvērums — klasisks skripts, ne modulis).
// Ielādējas PĒC app-gl.js un PIRMS app-start.js (kas izsauc init()): augšējā līmeņa kods šeit drīkst izmantot visu no
// app-gl.js; app-gl.js augšējā līmenī (ārpus funkcijām) šī faila nosaukumus izmantot nedrīkst. Pārbaude: tools/check-js.mjs.

// ---------- Ziņot (lietotāja ziņojumi) ----------
function wireAlerts() {
  // v124: big buttons for the 5 community report types only (tap "Ziņot" → tap a type = sent).
  const grid = $('reportGrid');
  grid.classList.add('report-grid-big');
  for (const type of REPORT_PICKER) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'report-btn report-btn-big'; b.dataset.type = type;
    b.innerHTML = `<img src="${alertDataUrl(type)}" alt="" width="64" height="64"><span></span>`;
    b.querySelector('span').textContent = REPORT_TYPE_CONFIG[type].label;
    b.addEventListener('click', () => reportAlert(type));
    grid.appendChild(b);
  }
  $('reportBtn').addEventListener('click', () => { reportSheetMsg(''); $('reportSheet').hidden = false; reportGpsRefresh(); });
  $('reportGpsBtn').addEventListener('click', () => {
    if (getLocationState() === 'denied') { openGpsHelp(); return; }
    gpsTimeouts = 0; gpsClear(); startGps(); reportGpsRefresh();             // „Mēģināt vēlreiz”
  });
  $('closeReport').addEventListener('click', () => { $('reportSheet').hidden = true; });
  setInterval(() => { if (!document.hidden) loadWeather(false); }, 60000);   // A13: fona cilnē nepieprasa
}

// ---------- Kopīgi ziņojumi (F10, reports.js + supabase/reports.sql) ----------
let reportsApi = null;
const reportsState = { timer: null, seq: 0, sending: false, watch: null, asked: new Set(), warned: new Set(),
  pending: new Map(),          // v124: low-trust reports waiting for YES — not drawn, but drivers are asked
  odo: 0, lastAskOdo: null,    // v124: metres driven; odometer value at the last prompt
  prompt: null };              // v124: the prompt on screen { it, timer }

// Uznirstošs paziņojums virs visa (nevis statusa joslā aiz loga)
function czToast(text, loud) { if (typeof parkToast === 'function') parkToast(text, loud); else setStatus(text); }
// Ziņa ziņošanas logā pie pogām
function reportSheetMsg(text, kind = 'err') {
  const m = $('reportMsg');
  if (!m) return;
  m.textContent = text; m.hidden = !text; m.className = 'rep-msg ' + kind;
}

function reportsInit() {
  reportsApi = new ReportsApi(typeof czAuthGet === 'function' ? czAuthGet() : null);
  const start = () => { loadReports(true); migrateOldReports(); };
  if (typeof czWhenConsent === 'function') czWhenConsent(start); else start();
  setInterval(() => { if (!document.hidden) loadReports(true); }, REPORT_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadReports(true); });
}
function loadReportsSoon() { clearTimeout(reportsState.timer); reportsState.timer = setTimeout(() => loadReports(false), 700); }

// Ielādē aktīvos ziņojumus redzamajam kartes apgabalam un aizstāj iepriekšējos
async function loadReports(force) {
  if (!reportsApi || !map || !alerts) return;
  if (typeof czConsentOk === 'function' && !czConsentOk()) return;
  const b = map.getBounds();
  const view = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  // Kartei pārvietojoties (arī braucot) — jauns pieprasījums tikai, ja redzamais apgabals iziet ārpus ielādētā
  const L = reportsState.box;
  if (!force && L && Date.now() - reportsState.at < REPORT_REFRESH_MS &&
      view.s >= L.min_lat && view.n <= L.max_lat && view.w >= L.min_lng && view.e <= L.max_lng) return;
  const bbox = reportBBox(view);
  if (!bbox) return;
  reportsState.box = bbox; reportsState.at = Date.now();
  const seq = ++reportsState.seq;
  let list;
  try { list = await reportsApi.list(bbox); } catch (e) { reportsState.box = null; console.warn('Ziņojumi nav ielādēti', e); return; }
  if (seq !== reportsState.seq) return;              // pa to laiku pieprasīts jaunāks
  for (const [id, it] of alerts.items) if (it.source === 'shared') alerts.items.delete(id);
  reportsState.pending.clear();
  for (const it of list) {
    if (!ALERT_TYPES[it.type]) continue;
    if (it.pending && !it.mine) reportsState.pending.set(it.id, it);   // v124: hidden until confirmed
    else alerts.items.set(it.id, it);
  }
  refreshAlerts();
}

// Mana vieta ziņojumam: uz ceļa, kur esmu (kartes piesaiste), citādi GPS vieta
// F20: ziņošanas logā — kāpēc nevar ziņot (pēc īstā iemesla) un pogas pelēkas, kamēr vietas nav
const REPORT_GPS = {
  denied: ['Atrašanās vieta nav atļauta — ieslēdz to, lai varētu ziņot.', 'Kā ieslēgt?'],
  searching: ['Meklē tavu atrašanās vietu…', ''],
  unavailable: ['Neizdodas noteikt atrašanās vietu. Pārbaudi, vai telefonā ir ieslēgta atrašanās vieta (GPS), un mēģini vēlreiz.', 'Mēģināt vēlreiz'],
};
function reportGpsRefresh() {
  const box = $('reportGps');
  if (!box) return;
  const st = getLocationState(), ok = st === 'ok' && !!reportPlace();
  const [text, btn] = ok ? ['', ''] : REPORT_GPS[st] || REPORT_GPS.searching;
  box.hidden = ok;
  box.className = 'rep-gps ' + (st === 'searching' ? 'info' : 'err');
  $('reportGpsText').textContent = text;
  $('reportGpsBtn').textContent = btn; $('reportGpsBtn').hidden = !btn;
  if (!reportsState.sending) for (const b of document.querySelectorAll('#reportGrid button')) b.disabled = !ok;
}
function reportPlace() {
  return signs.pos && !signs.pos.uncertain ? { lat: signs.pos.P[1], lng: signs.pos.P[0] } : state.me;
}
async function reportAlert(type) {
  if (reportsState.sending) return;
  const p = reportPlace();
  if (!p || getLocationState() !== 'ok') { reportGpsRefresh(); return; }                 // F20: iemesls un poga — loga augšā
  reportsState.sending = true;
  const btns = [...document.querySelectorAll('#reportGrid button')];
  btns.forEach(x => { x.disabled = true; });
  reportSheetMsg('Sūta…', 'info');
  try {
    const res = await reportsApi.create(type, p.lat, p.lng, state.heading);
    $('reportSheet').hidden = true;
    reportSheetMsg('');
    const cfg = REPORT_TYPE_CONFIG[type] || ALERT_TYPES[type], label = cfg.label;
    if (res && res.merged) czToast(`Paldies! „${label}” šeit jau bija ziņots — tavs apstiprinājums pieskaitīts.`);
    else czToast(`Paldies! „${label}” nosūtīts — to redz braucēji tajā pašā virzienā ${reportDur(cfg.ttl)}. ` +
      'Kad citi apstiprinās, saņemsi monētas.');
    await loadReports(true);
  } catch (e) {
    reportSheetMsg(reportErrorText(e.code));       // logs paliek atvērts — ziņa redzama pie pogām
  } finally {
    reportsState.sending = false;
    btns.forEach(x => { x.disabled = false; });
    reportGpsRefresh();
  }
}

// Popup pogas: citu ziņojumam „Vēl ir” / „Vairs nav”, savam — „Dzēst”
function reportPopupActions(el, it, popup, infoEl) {
  const row = document.createElement('div'); row.className = 'popup-actions';
  const msg = document.createElement('div'); msg.className = 'popup-msg'; msg.hidden = true;
  const say = (t, kind = 'err') => { msg.textContent = t; msg.hidden = !t; msg.className = 'popup-msg ' + kind; };
  const mk = (text, cls, fn) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small popup-btn ' + cls; b.textContent = text;
    b.addEventListener('click', async () => {
      row.querySelectorAll('button').forEach(x => { x.disabled = true; });
      say('Sūta…', 'info');
      try { await fn(); } catch (e) { say(reportErrorText(e.code)); row.querySelectorAll('button').forEach(x => { x.disabled = false; }); }
    });
    row.appendChild(b);
  };
  if (it.mine) {
    mk('Dzēst savu ziņojumu', 'ghost', async () => {
      await reportsApi.remove(it.rid);
      alerts.items.delete(it.id); refreshAlerts(); popup.remove();
      czToast('Ziņojums izdzēsts.');
    });
  } else {
    const vote = v => async () => {
      const r = await reportsApi.vote(it.rid, v);
      reportsState.asked.add(it.id);
      if (r && r.hidden) { alerts.items.delete(it.id); refreshAlerts(); popup.remove(); czToast('Paldies! Ziņojums noņemts no kartes.'); return; }
      it.myVote = v; it.still = r ? r.still : it.still;
      if (r && r.expires_at) it.expiresAt = Date.parse(r.expires_at);
      infoEl.textContent = reportInfo(it);
      say(v === 'still' ? 'Paldies! Apstiprināts.' : 'Paldies! Ja vēl kāds atzīmēs „vairs nav”, ziņojums pazudīs.', 'ok');
      row.querySelectorAll('button').forEach(x => { x.disabled = false; });
    };
    mk('Vēl ir', 'primary', vote('still'));
    mk('Vairs nav', 'ghost', vote('gone'));
  }
  el.append(row, msg);
}

// Driving: another driver's report ahead (≤ 500 m, same direction) → warning hook, and the v124 confirmation prompt.
// a — nextAlertAhead() result; undefined — alerts are off (nothing is asked).
function reportWatchAhead(a) {
  if (a === undefined) { reportsState.watch = null; return; }
  if (a && a.it.source === 'shared' && !a.it.mine && !reportsState.warned.has(a.it.id)) {
    reportsState.warned.add(a.it.id); reportAheadAlert(a.it, a.dist);
  }
  reportPromptTick();
}
// Hook for a spoken warning (F8). The "next" card already shows it visually.
function reportAheadAlert(it, dist) { /* e.g. voiceSay(`Pēc ${Math.round(dist / 50) * 50} metriem — ${it.title}`) */ }

// ---------- v124: confirmation prompt "Vai policija vēl ir šeit?" — JĀ / NĒ ----------
// Shown ~300 m before the point (jam: when entering it) for reports of other drivers in my direction,
// including pending ones that are not drawn yet. One at a time, max one per ~1 km, never right before
// a turn, hides itself after 7 s, sits above the bottom bar and never covers the turn instructions.
const REPORT_PROMPT_MS = 7000;
function reportPromptTick() {
  if (!alerts || !state.me) return;
  const cands = [...alerts.list().filter(it => it.source === 'shared' && !it.mine), ...reportsState.pending.values()];
  if (!cands.length) return;
  const a = nextAlertAhead(cands);
  const block = reportAskBlock(a, {
    asked: reportsState.asked, busy: !!reportsState.prompt, odo: reportsState.odo, lastAskOdo: reportsState.lastAskOdo,
    toTurn: state.nav.active ? state.nav.toNext : null, speedKmh: state.me.speedKmh,
  });
  if (block) return;
  reportsState.asked.add(a.it.id);
  reportsState.lastAskOdo = reportsState.odo;
  reportPromptShow(a.it);
}
function reportPromptHide() {
  const p = reportsState.prompt;
  if (!p) return;
  clearTimeout(p.timer); cancelAnimationFrame(p.raf);
  p.box.classList.remove('show');
  reportsState.prompt = null;
}
function reportPromptShow(it) {
  const cfg = REPORT_TYPE_CONFIG[it.type];
  let box = $('repPrompt');
  if (!box) {
    box = document.createElement('div'); box.id = 'repPrompt'; box.className = 'rep-prompt';
    box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-live', 'assertive');
    document.body.appendChild(box);
  }
  box.textContent = '';
  const head = document.createElement('div'); head.className = 'rp-head';
  const img = document.createElement('img'); img.src = alertDataUrl(it.type); img.alt = ''; img.width = 44; img.height = 44;
  const q = document.createElement('div'); q.className = 'rp-q'; q.textContent = cfg.question;
  const coin = document.createElement('div'); coin.className = 'rp-coin'; coin.textContent = '+' + cfg.reward;
  coin.title = 'Monētas par atbildi';
  head.append(img, q, coin);
  const btns = document.createElement('div'); btns.className = 'rp-btns';
  const mk = (text, cls, answer) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'rp-btn ' + cls; b.textContent = text;
    b.addEventListener('click', () => { reportPromptHide(); reportAnswer(it, answer); });
    btns.appendChild(b);
  };
  mk('JĀ', 'yes', 'yes'); mk('NĒ', 'no', 'no');
  const bar = document.createElement('div'); bar.className = 'rp-bar'; const fill = document.createElement('i'); bar.appendChild(fill);
  box.append(head, btns, bar);
  box.classList.add('show');
  const t0 = performance.now();
  const p = { it, box, timer: setTimeout(reportPromptHide, REPORT_PROMPT_MS), raf: 0 };
  const tick = () => {                                               // countdown bar
    if (reportsState.prompt !== p) return;
    fill.style.transform = `scaleX(${Math.max(0, 1 - (performance.now() - t0) / REPORT_PROMPT_MS)})`;
    p.raf = requestAnimationFrame(tick);
  };
  reportsState.prompt = p; tick();
}
// Sends the answer with the evidence the server validates (position, speed, heading, GPS accuracy).
async function reportAnswer(it, answer) {
  const me = state.me || {};
  try {
    const r = await reportsApi.confirm(it.rid, answer, { lat: me.lat, lng: me.lng, heading: state.heading,
      speedKmh: me.speedKmh, accuracy: me.accuracy, mock: !!state.testMode });
    it.myVote = answer === 'yes' ? 'still' : 'gone';
    if (r && r.hidden) { alerts.items.delete(it.id); reportsState.pending.delete(it.id); refreshAlerts(); }
    else if (r && r.expires_at) it.expiresAt = Date.parse(r.expires_at);
    const coins = r && +r.coins || 0;
    if (coins > 0) czToast(`Paldies! +${coins} monētas`);
    else if (r && r.legacy) czToast('Paldies!');
    else if (state.testMode) czToast('Paldies! (testa režīmā monētas netiek dotas)');
    else czToast(r && r.daily_left === 0 ? 'Paldies! Šodienas monētu limits (100) ir sasniegts.' : 'Paldies!');
    if (r && r.balance != null && typeof garageSetBalance === 'function') garageSetBalance(+r.balance);
  } catch (e) { czToast(reportErrorText(e.code), true); }
}

// Agrākie ierīcē saglabātie ziņojumi: aktīvos vienreiz augšupielādē serverī, tad atslēgu iztīra
async function migrateOldReports() {
  const old = store.get('reports', null);
  if (old == null) return;
  const todo = reportsToMigrate(old);
  let sent = 0;
  for (const r of todo) {
    try { await reportsApi.create(r.type, r.lat, r.lng, r.heading, r.minutes); sent++; }
    catch (e) { if (e.code === 'network' || e.code === 'consent') return; }   // vēlāk mēģinās vēlreiz
  }
  try { localStorage.removeItem(REPORT_OLD_KEY); } catch { /* */ }
  if (sent) { czToast(`Tavi agrākie ziņojumi (${sent}) tagad redzami visiem.`); loadReports(true); }
}
