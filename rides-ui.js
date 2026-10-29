// ---------- Kopbraucieni: saskarne ----------
// Poga "Kopā" → logs ar divām cilnēm: "Man vajag aizbraukt" (pasažieris) un "Es braucu" (šoferis).
// Izmanto app-gl.js kopīgās lietas: $, state, map, store, searchPhoton, selectDestination, setStatus.

const rides = {
  store: null, ready: false, tab: 'need', open: false,
  profile: null, myReqs: [], offers: {}, myOffers: [], openList: [],
  timer: null, markers: [], seen: null, from: null, to: null,
  msgs: {}, seenMsg: {}, chat: null, unreadTotal: 0,             // čats
  pay: {}, payCfg: null, payDrv: null, payAt: 0, payDrvBusy: false,      // kartes maksājumi
  payDrvOk: {}, payDrvTries: {},                                          // F11: vai šoferis pieņem karti (pasažierim)
  history: [], historyAt: 0, historyErr: false, historyView: false, historyOpen: null,  // F13: „Mani braucieni”
  ratingSum: {}, ratingAt: {}, rateDraft: {}, reportOpen: null, reportDraft: {}, summarySeen: [],
  statsView: false, myStats: null, myStatsErr: false, adminView: false, admin: null, adminFees: null, adminErr: null,   // F16
  adminBusy: false, isAdmin: false, isAdminFor: null,
  live: { timer: null, lastDrv: null, lastPas: 0, route: null, routeKey: '', routeAt: 0, carMarker: null, pasMarker: null, destMarker: null },
};
try { rides.seenMsg = JSON.parse(localStorage.getItem('cz.rides.seenMsg') || '{}'); } catch { rides.seenMsg = {}; }
try { rides.summarySeen = JSON.parse(localStorage.getItem('cz.rides.summarySeen') || '[]'); } catch { rides.summarySeen = []; }
// F12: noraidītie piedāvājumi — „Labi” nospiestie un brīdis, kad lietotne noraidījumu pamanīja (ja datubāzē nav responded_at)
try { rides.declOk = JSON.parse(localStorage.getItem('cz.rides.declOk') || '[]'); } catch { rides.declOk = []; }
try { rides.declSeen = JSON.parse(localStorage.getItem('cz.rides.declSeen') || '{}'); } catch { rides.declSeen = {}; }

function rEl(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const R_PIN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2.5c-3.9 0-7 3-7 6.8C5 14.5 12 21.5 12 21.5s7-7 7-12.2c0-3.8-3.1-6.8-7-6.8Z" fill="currentColor"/><circle cx="12" cy="9.4" r="2.4" fill="#fff"/></svg>';
function rIcon(svg) { const s = document.createElement('span'); s.className = 'r-icon'; s.innerHTML = svg; return s; }

async function ridesInit() {
  if (rides.store) return;            // jau palaists
  rides.store = createRideStore(typeof RIDES_CONFIG !== 'undefined' ? RIDES_CONFIG : null);
  $('ridesBtn').addEventListener('click', () => ridesOpen(true));
  $('closeRides').addEventListener('click', () => ridesOpen(false));
  $('tabNeed').addEventListener('click', () => ridesTab('need'));
  $('tabDrive').addEventListener('click', () => ridesTab('drive'));
  $('ridesDemoAdd').addEventListener('click', ridesAddDemo);
  const accBtn = $('accountBtn');
  if (accBtn) accBtn.addEventListener('click', () => { if (typeof toggleSettings === 'function') toggleSettings(false); ridesOpenAccount(); });
  for (const id of ['settingsBtn', 'reportBtn', 'placesBtn']) { const b = $(id); if (b) b.addEventListener('click', () => { if (rides.open) ridesOpen(false); }); }
  $('ridesDemo').hidden = !rides.store.demo;
  rides.tab = store.get('ridesTab', 'need');
  // Konts: atverot lietotni tikai atjauno esošu sesiju (jaunu NEVEIDO) — un tikai pēc piekrišanas noteikumiem.
  czWhenConsent(async () => {
    try { await rides.store.init(); rides.ready = true; }
    catch (err) { console.warn('Kopbraucieni nav pieejami', err); rides.ready = false; }
    const ret = await ridesAuthReturn();                    // atgriešanās no e-pasta saites / Google
    if (rides.ready && rides.store.hasAccount()) {
      try { const t = await rides.store.auth.claimPending(); if (t && t.ok && !t.same) ridesAccountNote(t); } catch { /* */ }
      await ridesRefresh(true); ridesPayReturn();
    }
    ridesSchedule();
    if (ret) ridesOpen(true);
  });
}
// Pirmo reizi atverot „Kopā” — izveido (anonīmu) kontu; ja lietotājs bija izrakstījies — piedāvā pieslēgties.
async function ridesEnsureAccount() {
  if (!rides.ready || !rides.store || rides.store.hasAccount() || rides.accountBusy) return;
  if (ridesSignedOut()) { rides.accountView = true; ridesRender(true); return; }
  rides.accountBusy = true; ridesRender(true);
  try { await rides.store.ensureAccount(); rides.accountErr = null; }
  catch (e) { console.warn('Konts', e); rides.accountErr = e && e.code === 'consent' ? 'Vispirms jāpiekrīt lietošanas noteikumiem.' : 'Neizdevās savienoties ar serveri. Pārbaudi internetu un mēģini vēlreiz.'; }
  rides.accountBusy = false;
  await ridesRefresh(true);
  ridesRender(true);
}
function ridesSignedOut() { try { return localStorage.getItem('cz.auth.signedOut') === '1'; } catch { return false; } }
function ridesSetSignedOut(v) { try { if (v) localStorage.setItem('cz.auth.signedOut', '1'); else localStorage.removeItem('cz.auth.signedOut'); } catch { /* */ } }
// Aktīvs brauciens (pieņemts piedāvājums) — tad dati atjaunojas biežāk un notiek atrašanās vietas apmaiņa.
function ridesActiveTrip() {
  for (const r of rides.myReqs) { const o = (rides.offers[r.id] || []).find(x => x.status === 'accepted'); if (o) return { role: 'passenger', o, req: r }; }
  const d = rides.myOffers.find(o => o.status === 'accepted' && o.trip !== 'done');
  return d ? { role: 'driver', o: d, req: d.request } : null;
}
function ridesSchedule() {
  clearTimeout(rides.timer);
  const tick = async () => {
    const trip = ridesActiveTrip();
    const active = trip || rides.myReqs.length || rides.myOffers.some(o => o.status === 'pending');
    if (rides.open || active) { try { await ridesShareLocation(); await ridesRefresh(false); } catch { /* */ } }
    ridesLiveMap();
    const delay = rides.chat ? 4000 : trip ? 5000 : 15000;
    rides.timer = setTimeout(tick, delay);
  };
  rides.timer = setTimeout(tick, 4000);
}
// Šoferis (pēc "Braukt pakaļ") sūta savu vietu ik ~5 s; pasažieris — savu ik ~15 s, kamēr gaida.
async function ridesShareLocation() {
  const trip = ridesActiveTrip();
  if (!trip || !state.me) return;
  const now = Date.now(), me = state.me;
  if (trip.role === 'driver' && ['coming', 'arrived', 'onboard'].includes(trip.o.trip)) {
    const l = rides.live.lastDrv;
    if (!l || now - l.at > 20000 || rideDist(l.lat, l.lng, me.lat, me.lng) > 15) {
      rides.live.lastDrv = { at: now, lat: me.lat, lng: me.lng };
      await rides.store.driverUpdate(trip.o.id, { lat: me.lat, lng: me.lng, heading: state.heading ?? null });
    }
  }
  if (trip.role === 'passenger' && !['onboard', 'done'].includes(trip.o.trip) && now - rides.live.lastPas > 15000) {
    rides.live.lastPas = now;
    await rides.store.passengerUpdate(trip.o.id, me.lat, me.lng);
  }
}
function ridesOpen(open) {
  rides.open = open;
  $('ridesSheet').hidden = !open;
  if (open) {
    $('ridesBtn').classList.remove('has-news');
    for (const id of ['settings', 'reportSheet', 'placesSheet']) { const el = $(id); if (el) el.hidden = true; }
    ridesTab(rides.tab);
    if (rides.ready && rides.store.hasAccount && !rides.store.hasAccount() && !rides.accountView) ridesEnsureAccount(); else ridesRefresh(false);
  } else ridesMarkers([]);
}
function ridesTab(tab) {
  rides.tab = tab; store.set('ridesTab', tab);
  $('tabNeed').setAttribute('aria-selected', tab === 'need');
  $('tabDrive').setAttribute('aria-selected', tab === 'drive');
  ridesRender(true);
}

// Datu atjaunošana (arī fonā ik 15 s, ja ir aktīvi braucieni). first — bez paziņojumiem.
async function ridesRefresh(first) {
  if (!rides.ready) return ridesRender();
  if (!rides.store.hasAccount()) {
    rides.profile = null; rides.myReqs = []; rides.offers = {}; rides.myOffers = []; rides.openList = []; rides.msgs = {};
    if (rides.history.length || rides.historyView) ridesHistoryReset();
    return ridesRender();
  }
  try {
    // Ik 5 min sakārto novecojušos braucienus (neapstiprināti, nesākti vai "aizmirsti" ceļā)
    if (rides.store.expire && Date.now() - (rides.expireAt || 0) > 5 * 60000) {
      rides.expireAt = Date.now();
      try { await rides.store.expire(); } catch (e) { console.warn('Braucienu tīrīšana', e); }
    }
    rides.profile = await rides.store.profile();
    const wasActive = ridesActiveOfferIds();
    rides.myReqs = await rides.store.myRequests();
    rides.offers = {};
    for (const r of rides.myReqs) rides.offers[r.id] = await rides.store.offersFor(r.id);
    const wasPending = new Set(rides.myOffers.filter(o => o.status === 'pending').map(o => o.id));
    rides.myOffers = await rides.store.myOffers();
    ridesDeclinedTrack(wasPending);
    if (rides.open && rides.tab === 'drive') rides.openList = await rides.store.openRequests(ridesBox());
    // Čata ziņas visiem aktīvajiem piedāvājumiem (gaida atbildi vai pieņemti)
    const ids = ridesChatOffers().map(x => x.o.id);
    const msgs = {};
    for (const id of ids) {
      const have = rides.msgs[id] || [];
      const fresh = await rides.store.messages(id, have.length ? have[have.length - 1].id : 0);
      msgs[id] = have.concat(fresh || []);
    }
    rides.msgs = msgs;
    await ridesPayRefresh(first);
    await ridesRefundSync();
    // F13: pazudis aktīvs brauciens (pabeigts / atcelts) → uzreiz ielādē vēsturi (kopsavilkums)
    const nowActive = ridesActiveOfferIds();
    await ridesHistoryLoad(first || [...wasActive].some(id => !nowActive.has(id)));
    await ridesRatingsLoad();
    if (rides.isAdminFor !== rides.store.id) {                                // F16: īpašnieka statistika — pārbauda serveris
      rides.isAdminFor = rides.store.id;
      rides.isAdmin = rides.store.isAdmin ? await rides.store.isAdmin() : false;
    }
  } catch (err) { console.warn('Kopbraucieni: neizdevās atjaunot', err); }
  ridesNotify(first);
  ridesRender();
  ridesLiveText();
  if (rides.chat) ridesChatUpdate();
}
// Ar kuriem piedāvājumiem var sarakstīties (pasažieris — ar šoferiem; šoferis — ar pasažieriem).
function ridesChatOffers() {
  const out = [];
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) if (o.status === 'pending' || o.status === 'accepted') out.push({ o, name: (o.driver && o.driver.name) || 'Šoferis' });
  for (const o of rides.myOffers) if (o.status === 'pending' || o.status === 'accepted') out.push({ o, name: (o.passenger && o.passenger.name) || 'Pasažieris' });
  return out;
}
function ridesUnread(offerId) { return rideUnread(rides.msgs[offerId], rides.store.id, rides.seenMsg[offerId] || 0); }
function ridesMarkSeen(offerId) {
  const m = rides.msgs[offerId] || [];
  if (!m.length) return;
  rides.seenMsg[offerId] = m[m.length - 1].id;
  try { localStorage.setItem('cz.rides.seenMsg', JSON.stringify(rides.seenMsg)); } catch { /* */ }
}
// Paziņojumi: jauns piedāvājums manam pieprasījumam / mans piedāvājums pieņemts.
function ridesNotify(first) {
  const sig = new Set();
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) sig.add('o:' + o.id + ':' + o.status);
  for (const o of rides.myOffers) sig.add('m:' + o.id + ':' + o.status);
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) if (o.trip) sig.add('t:' + o.id + ':' + o.trip);
  if (rides.chat) ridesMarkSeen(rides.chat.offerId);
  let unread = 0, lastMsg = null;
  for (const x of ridesChatOffers()) {
    const n = ridesUnread(x.o.id); unread += n;
    if (n) { const m = rides.msgs[x.o.id]; lastMsg = { name: x.name, body: m[m.length - 1].body }; }
  }
  const moreUnread = unread > rides.unreadTotal; rides.unreadTotal = unread;
  const prev = rides.seen; rides.seen = sig;
  if (first || !prev) return;
  const fresh = [...sig].filter(s => !prev.has(s));
  let msg = null;
  if (fresh.some(s => s.startsWith('t:') && s.endsWith(':arrived'))) {
    msg = 'Šoferis ir klāt!';
  }
  else if (fresh.some(s => s.startsWith('t:') && s.endsWith(':coming'))) msg = 'Šoferis dodas pie tevis — redzi viņu kartē.';
  else if (fresh.some(s => s.startsWith('t:') && s.endsWith(':onboard'))) msg = 'Brauciens sācies — maršruts redzams kartē.';
  else if (fresh.some(s => s.startsWith('m:') && s.endsWith(':accepted'))) msg = 'Pasažieris pieņēma tavu piedāvājumu!';
  else if (fresh.some(s => s.startsWith('m:') && s.endsWith(':declined'))) {
    const d = rides.myOffers.find(o => o.status === 'declined' && fresh.includes('m:' + o.id + ':declined'));
    msg = (d ? rideDeclinedText(d) : 'Pasažieris izvēlējās citu šoferi') + '.';                    // F12: arī kartītē
  }
  else if (fresh.some(s => s.startsWith('o:') && s.endsWith(':pending'))) msg = 'Kāds šoferis piedāvā tevi aizvest!';
  else if (moreUnread && lastMsg) msg = `Ziņa no ${lastMsg.name}: ${lastMsg.body.slice(0, 60)}`;
  if (!msg) return;
  if (rides.open) ridesToast(msg);                         // F9: logs atvērts — statusa josla aiz tā nav redzama
  else { setStatus(msg); $('ridesBtn').classList.add('has-news'); }
  try { navigator.vibrate && navigator.vibrate([120, 80, 120]); } catch { /* */ }
}
function ridesBox() {
  const c = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  if (state.nav.route) {
    const xs = state.nav.route.coords.map(p => p[0]), ys = state.nav.route.coords.map(p => p[1]);
    return { s: Math.min(...ys) - 0.01, n: Math.max(...ys) + 0.01, w: Math.min(...xs) - 0.015, e: Math.max(...xs) + 0.015 };
  }
  return { s: c.lat - 0.05, n: c.lat + 0.05, w: c.lng - 0.085, e: c.lng + 0.085 };
}

// ---------- Zīmēšana ----------
// Ko logs pašlaik rāda — ja pēc datu atjaunošanas nekas nav mainījies, logu NEpārzīmē
// (citādi pazustu tas, ko cilvēks pašlaik raksta laukos).
function ridesViewSig() {
  return JSON.stringify([rides.ready, rides.tab, rides.profile ? rides.profile.name + '|' + rides.profile.phone + '|' + rides.profile.car : null,
    rides.extraForm,
    rides.myReqs.map(r => r.id + r.status + (rides.offers[r.id] || []).map(o => o.id + o.status + o.phone + o.trip + ridesUnread(o.id)).join()),
    rides.myOffers.map(o => o.id + o.status + o.phone + o.trip + ridesUnread(o.id) + (o.request && o.request.status)),
    rides.chat ? rides.chat.offerId : null,
    rides.tab === 'drive' ? rides.openList.map(r => r.id + r.status) : null,
    rides.pay, rides.payCfg, rides.payDrv,
    rides.accountView, rides.accountMode, rides.accountBusy, rides.accountMsg, rides.providers,
    rides.store && rides.store.auth ? [rides.store.auth.userId, rides.store.auth.isAnon, rides.store.auth.email] : null,
    // F13: vēsture, kopsavilkumi, vērtējumi, ziņošana
    rides.historyView, rides.historyOpen, rides.historyErr, rides.reportOpen, rides.summarySeen.length,
    rides.history.map(h => (h.offer_id || h.request_id) + h.status + (h.my_stars || 0) + (h.reported ? 1 : 0)),
    rides.ratingSum,
    ridesDeclinedList().map(o => o.id),
    rides.statsView, rides.myStats, rides.myStatsErr, rides.adminView, rides.admin, rides.adminFees, rides.adminErr, rides.adminBusy, rides.isAdmin]);   // F16                                // F12: noraidītie (pazūd pēc 10 min / „Labi”)
}
function ridesRender(force = false) {
  if (!rides.open) return;
  const body = $('ridesBody');
  // Atvērts čats: tikai pievieno jaunās ziņas (ievades lauks paliek neaiztikts).
  if (!force && rides.chat && rides.renderedChat === rides.chat.offerId && $('rcList')) { ridesChatUpdate(); return; }
  const sig = ridesViewSig();
  if (!force && sig === rides.renderedSig && body.childNodes.length) return;
  // Kamēr cilvēks raksta kādā laukā, nepārzīmē, ja vien nav mainījies kas būtisks (piem. atnācis piedāvājums).
  const typing = body.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (!force && typing && rides.renderedSig && JSON.parse(sig)[3] === JSON.parse(rides.renderedSig)[3]
      && JSON.parse(sig)[4] === JSON.parse(rides.renderedSig)[4] && JSON.parse(sig)[2] === JSON.parse(rides.renderedSig)[2]) return;
  rides.renderedSig = sig;
  body.replaceChildren();
  if (!rides.ready) {
    body.append(rEl('p', { class: 'fine', text: 'Kopbraucieni pašlaik nav pieejami (nav savienojuma ar serveri). Pamēģini vēlāk.' }));
    return;
  }
  if (rides.accountView) return body.append(ridesAccountView());
  if (!rides.store.hasAccount()) {
    if (rides.accountBusy) return body.append(rEl('p', { class: 'fine', text: 'Sagatavo kontu…' }));
    return body.append(rEl('div', { class: 'r-form' },
      rEl('p', { class: 'r-err', text: rides.accountErr || 'Kopbraucieniem vajadzīgs konts.' }),
      rEl('button', { class: 'btn primary', type: 'button', text: 'Mēģināt vēlreiz', onclick: () => { ridesSetSignedOut(false); ridesEnsureAccount(); } })));
  }
  if (rides.historyView && rides.profile && !rides.chat) return body.append(ridesHistoryView());   // F13
  if (rides.statsView && !rides.chat) return body.append(ridesMyStatsView());                     // F16
  if (rides.adminView && !rides.chat) return body.append(ridesAdminView());
  if (!rides.chat) body.append(ridesAccountBar());
  if (!rides.profile) return body.append(ridesProfileForm());
  rides.renderedChat = rides.chat ? rides.chat.offerId : null;
  if (rides.chat) { body.append(ridesChatView()); return ridesChatUpdate(); }
  body.append(rides.tab === 'need' ? ridesNeedView() : ridesDriveView());
  if (rides.tab !== 'drive') ridesMarkers([]);
}

function ridesProfileForm(editing = false) {
  const p = rides.profile || {};
  // Auto jautā tikai šoferim (cilnē „Es braucu, varu paņemt”). Ierakstīto saglabā, pārslēdzot cilnes.
  const driver = rides.tab === 'drive';
  const d = rides.draft || (rides.draft = { name: p.name || '', phone: p.phone || '', car: p.car || '' });
  const field = (key, attrs) => {
    const el = rEl('input', { class: 'r-input', ...attrs }); el.value = d[key] || '';
    el.addEventListener('input', () => { d[key] = el.value; });
    return el;
  };
  const name = field('name', { id: 'rpName', maxlength: 40, autocomplete: 'given-name', placeholder: 'Piem. Ilze' });
  const phone = field('phone', { id: 'rpPhone', type: 'tel', maxlength: 20, autocomplete: 'tel', placeholder: '+371 2…' });
  const car = driver ? field('car', { id: 'rpCar', maxlength: 60, placeholder: 'Piem. pelēka Škoda Octavia' }) : null;
  const err = rEl('p', { class: 'r-err', hidden: true });
  const save = async () => {
    const v = { name: name.value, phone: phone.value, car: car ? car.value : (p.car || '') };
    const e = rideProfileValid(v);
    if (e) { err.textContent = e; err.hidden = false; return; }
    try { await rides.store.saveProfile(v); rides.draft = null; await ridesRefresh(true); ridesRender(true); }
    catch (x) { err.textContent = 'Neizdevās saglabāt. Pamēģini vēlreiz.'; err.hidden = false; console.warn(x); }
  };
  return rEl('div', { class: 'r-form' },
    rEl('p', { class: 'r-lead', text: editing ? 'Tavs profils' : 'Vispirms pastāsti, kā tevi sauc — to redzēs otrs brauciena dalībnieks.' }),
    rEl('label', { class: 'r-label', for: 'rpName', text: 'Vārds' }), name,
    rEl('label', { class: 'r-label', for: 'rpPhone', text: 'Tālrunis (redzams tikai tam, ar kuru vienosieties)' }), phone,
    ...(car ? [rEl('label', { class: 'r-label', for: 'rpCar', text: 'Tavs auto (neobligāti — pēc tā pasažieris tevi atpazīs)' }), car] : []),
    err,
    rEl('button', { class: 'btn primary r-wide', type: 'button', onclick: save, text: 'Saglabāt' }));
}

// Šoferim bez norādīta auto — neliels lauks, lai pasažieris viņu atpazītu.
function ridesCarPrompt() {
  const car = rEl('input', { class: 'r-input', id: 'rdCar', maxlength: 60, placeholder: 'Piem. pelēka Škoda Octavia' });
  const err = rEl('p', { class: 'r-err', hidden: true });
  const save = async () => {
    if (!car.value.trim()) { car.focus(); return; }
    try { await rides.store.saveProfile({ ...rides.profile, car: car.value }); await ridesRefresh(true); ridesRender(true); }
    catch (x) { err.textContent = 'Neizdevās saglabāt. Pamēģini vēlreiz.'; err.hidden = false; console.warn(x); }
  };
  car.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  return rEl('div', { class: 'r-form r-carprompt' },
    rEl('label', { class: 'r-label', for: 'rdCar', text: 'Kāds ir tavs auto? Pēc tā pasažieris tevi atpazīs (neobligāti).' }),
    rEl('div', { class: 'r-row' }, car, rEl('button', { class: 'btn primary', type: 'button', onclick: save, text: 'Saglabāt' })),
    err);
}

// Adreses lauks ar ieteikumiem (tā pati meklēšana, kas galamērķim).
function ridesPlaceInput(id, placeholder, onPick, initial) {
  const input = rEl('input', { class: 'r-input', id, placeholder, autocomplete: 'off', enterkeyhint: 'search' });
  if (initial) input.value = initial.name;
  const list = rEl('ul', { class: 'r-suggest', hidden: true });
  let t = null, seq = 0;
  input.addEventListener('input', () => {
    onPick(null);
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; return; }
    t = setTimeout(async () => {
      const my = ++seq;
      let items = [];
      try { items = await searchPhoton(q); } catch { items = []; }
      if (my !== seq) return;
      list.replaceChildren(...items.slice(0, 5).map(it => rEl('li', {},
        rEl('button', { type: 'button', onclick: () => { input.value = it.name; list.hidden = true; onPick(it); } },
          rIcon(R_PIN), rEl('span', { class: 'r-sg' }, rEl('strong', { text: it.name }), rEl('small', { text: it.sub || '' }))))));
      if (!items.length) list.replaceChildren(rEl('li', { class: 'r-empty', text: 'Nekas netika atrasts.' }));
      list.hidden = false;
    }, 300);
  });
  return rEl('div', { class: 'r-place' }, input, list);
}

function ridesNeedView() {
  const wrap = rEl('div');
  // F13: pabeigta brauciena kopsavilkums (vērtējums) augšā; tukšo formu rāda tikai, ja tādu nav
  const sums = rideSummaryPending(rides.history, rides.summarySeen, 'passenger');
  for (const h of sums) wrap.append(ridesSummaryCard(h));
  if (sums.length && !rides.myReqs.length) {
    if (rides.extraForm) wrap.append(ridesNeedForm());
    else wrap.append(rEl('button', { class: 'btn ghost r-wide', type: 'button', text: '+ Jauns brauciens', onclick: () => { rides.extraForm = true; ridesRender(true); } }));
    return wrap;
  }
  for (const r of rides.myReqs) wrap.append(ridesRequestCard(r));
  if (rides.myReqs.length) {
    if (rides.extraForm) wrap.append(ridesNeedForm());
    else wrap.append(rEl('button', { class: 'link-btn r-more', type: 'button', text: '+ Vēl viens brauciens', onclick: () => { rides.extraForm = true; ridesRender(true); } }));
    return wrap;
  }
  wrap.append(ridesNeedForm());
  wrap.append(rEl('div', { class: 'r-pay-info' },
    rEl('b', { text: '💳 Kā samaksāt?' }),
    rEl('span', { text: 'Kartes dati iepriekš nav jāievada. Kad šoferis pieņems braucienu ar cenu, parādīsies poga „Maksāt ar karti” — tā atvērs drošu Stripe lapu. Vari samaksāt arī skaidrā naudā.' })));
  return wrap;
}
function ridesNeedForm() {
  const here = state.me ? { name: 'Mana atrašanās vieta', lat: state.me.lat, lng: state.me.lng } : null;
  rides.from = here; rides.to = null;
  const when = rEl('select', { class: 'r-input', id: 'rqWhen' },
    ...[['0', 'Tagad'], ['15', 'Pēc 15 min'], ['30', 'Pēc 30 min'], ['60', 'Pēc 1 h'], ['120', 'Pēc 2 h'], ['180', 'Pēc 3 h'], ['other', 'Cits laiks…']]
      .map(([v, l]) => rEl('option', { value: v, text: l })));
  const at = rEl('input', { class: 'r-input', id: 'rqAt', type: 'datetime-local', hidden: true });
  when.addEventListener('change', () => { at.hidden = when.value !== 'other'; });
  const seats = rEl('select', { class: 'r-input r-seats', id: 'rqSeats' }, ...[1, 2, 3, 4].map(n => rEl('option', { value: n, text: n + (n === 1 ? ' cilvēks' : ' cilvēki') })));
  const note = rEl('input', { class: 'r-input', id: 'rqNote', maxlength: 200, placeholder: 'Piezīme, piem. “ar mazu somu”' });
  const err = rEl('p', { class: 'r-err', hidden: true });
  const submit = async () => {
    const depart = when.value === 'other' ? (at.value ? new Date(at.value) : null) : new Date(Date.now() + (+when.value) * 60000);
    const f = rides.from || (state.me ? { name: 'Mana atrašanās vieta', lat: state.me.lat, lng: state.me.lng } : null);
    const t = rides.to;
    const req = { from_lat: f && f.lat, from_lng: f && f.lng, from_name: f ? f.name : '', to_lat: t && t.lat, to_lng: t && t.lng, to_name: t ? t.name : '',
      depart_at: depart ? depart.toISOString() : '', seats: +seats.value, note: note.value.trim() };
    const e = rideValidate(req);
    if (e) { err.textContent = e; err.hidden = false; return; }
    try { await rides.store.createRequest(req); rides.extraForm = false; await ridesRefresh(true); ridesRender(true); ridesToast('Pieprasījums publicēts — šoferi to redz.'); }
    catch (x) { err.textContent = 'Neizdevās publicēt. Pamēģini vēlreiz.'; err.hidden = false; console.warn(x); }
  };
  return rEl('div', { class: 'r-form' },
    rEl('label', { class: 'r-label', for: 'rqFrom', text: 'No kurienes' }),
    ridesPlaceInput('rqFrom', state.me ? 'Mana atrašanās vieta' : 'Ieraksti adresi', p => { rides.from = p || (state.me ? here : null); }, null),
    rEl('label', { class: 'r-label', for: 'rqTo', text: 'Uz kurieni' }),
    ridesPlaceInput('rqTo', 'Ieraksti adresi', p => { rides.to = p; }, null),
    rEl('div', { class: 'r-two' },
      rEl('div', {}, rEl('label', { class: 'r-label', for: 'rqWhen', text: 'Kad' }), when, at),
      rEl('div', {}, rEl('label', { class: 'r-label', for: 'rqSeats', text: 'Cik cilvēku' }), seats)),
    rEl('label', { class: 'r-label', for: 'rqNote', text: 'Piezīme (neobligāti)' }), note,
    err,
    rEl('button', { class: 'btn primary r-wide', type: 'button', onclick: submit, text: 'Meklēt šoferi' }));
}
function ridesRoute(r) {
  return rEl('div', { class: 'r-route' },
    rEl('div', { class: 'r-stop' }, rEl('span', { class: 'r-dot r-dot-a' }), rEl('span', { text: r.from_name || 'Sākums' })),
    rEl('div', { class: 'r-stop' }, rEl('span', { class: 'r-dot r-dot-b' }), rEl('span', { text: r.to_name || 'Galamērķis' })));
}
function ridesPerson(p, phone, extra, userId) {
  const sum = userId ? rides.ratingSum[userId] : undefined;          // F13: vidējais vērtējums
  return rEl('div', { class: 'r-person' },
    rEl('span', { class: 'r-avatar', text: ((p && p.name) || '?').trim().charAt(0).toUpperCase() }),
    rEl('div', { class: 'r-pinfo' }, rEl('strong', { text: (p && p.name) || 'Lietotājs' }),
      rEl('small', { text: [p && p.car, extra].filter(Boolean).join(' · ') }),
      sum !== undefined ? rEl('small', { class: 'r-rating' + (sum && sum.count ? '' : ' none'), text: rideRatingText(sum) }) : null),
    phone ? rEl('a', { class: 'r-call', href: 'tel:' + phone.replace(/[^\d+]/g, ''), text: 'Zvanīt' }) : null);
}
function ridesRequestCard(r) {
  const offers = rides.offers[r.id] || [];
  const accepted = offers.find(o => o.status === 'accepted');
  const pending = offers.filter(o => o.status === 'pending');
  const card = rEl('div', { class: 'r-card' + (accepted ? ' r-ok' : '') },
    rEl('div', { class: 'r-card-top' },
      rEl('span', { class: 'r-badge', text: accepted ? 'Šoferis atrasts' : 'Meklē šoferi…' }),
      rEl('span', { class: 'r-when', text: rideTimeText(r.depart_at) + ' · ' + r.seats + (r.seats === 1 ? ' cilv.' : ' cilv.') })),
    ridesRoute(r));
  if (accepted) {
    const st = rideStage(accepted);
    card.querySelector('.r-badge').textContent = { matched: 'Šoferis atrasts', coming: 'Šoferis brauc pakaļ', arrived: 'Šoferis ir klāt!', onboard: 'Ceļā' }[st] || 'Šoferis atrasts';
    card.append(ridesPerson(accepted.driver, accepted.phone, '', accepted.driver_id));
    card.append(rEl('p', { class: 'r-trip', id: 'trip-' + accepted.id, text: ridePassengerStatus(accepted, r) }));
    const payEl = ridesPassengerPay(accepted);
    if (payEl) card.append(payEl);
    if (st !== 'onboard') card.append(rEl('p', { class: 'fine', text: 'Pirms iekāpšanas pārliecinies, ka auto atbilst aprakstam.' }));
    const acts = rEl('div', { class: 'r-actions' });
    if (st !== 'onboard') acts.append(rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt', onclick: () => ridesConfirmCancel(r) }));
    acts.append(ridesChatBtn(accepted.id, (accepted.driver && accepted.driver.name) || 'Šoferis'));
    if (st === 'coming' || st === 'arrived' || st === 'onboard') acts.append(rEl('button', { class: 'btn primary', type: 'button', text: 'Kartē', onclick: () => ridesShowTripOnMap() }));
    card.append(acts);
  } else {
    if (!pending.length) card.append(rEl('p', { class: 'fine r-wait', text: 'Pieprasījumu redz šoferi, kuri brauc tajā pusē. Kad kāds piedāvās, tas parādīsies šeit.' }));
    for (const o of pending) {
      card.append(rEl('div', { class: 'r-offer' },
        ridesPerson(o.driver, '', [o.eta_min != null ? `var paņemt pēc ~${o.eta_min} min` : '', o.price_cents ? 'cena ' + rideMoney(o.price_cents) : 'bez maksas / vienosieties'].filter(Boolean).join(' · '), o.driver_id),
        o.note ? rEl('p', { class: 'r-note', text: '“' + o.note + '”' }) : null,
        rEl('div', { class: 'r-actions' },
          ridesChatBtn(o.id, (o.driver && o.driver.name) || 'Šoferis'),
          rEl('button', { class: 'btn ghost', type: 'button', text: 'Noraidīt', onclick: async () => { await rides.store.respond(o.id, 'declined'); ridesRefresh(true); } }),
          rEl('button', { class: 'btn primary', type: 'button', text: 'Pieņemt', onclick: async () => { await rides.store.respond(o.id, 'accepted'); ridesRefresh(true); ridesToast('Brauciens saskaņots!'); } }))));
    }
    card.append(rEl('button', { class: 'link-btn r-cancel', type: 'button', text: 'Atsaukt pieprasījumu', onclick: () => ridesConfirmCancel(r) }));
  }
  return card;
}
function ridesConfirmCancel(r) {
  const card = document.activeElement && document.activeElement.closest('.r-card');
  const box = rEl('div', { class: 'r-confirm' },
    rEl('span', { text: 'Tiešām atcelt?' }),
    rEl('button', { class: 'link-btn', type: 'button', text: 'Nē', onclick: () => box.remove() }),
    rEl('button', { class: 'btn danger small', type: 'button', text: 'Jā, atcelt', onclick: async e => {
      e.currentTarget.disabled = true;
      const acc = (rides.offers[r.id] || []).find(o => o.status === 'accepted');
      await rides.store.setRequestStatus(r.id, 'cancelled');
      if (acc) await ridesRefundAfterCancel(acc);          // samaksāts ar karti → automātiska atmaksa
      ridesRefresh(true);
    } }));
  (card || $('ridesBody')).append(box);
}

function ridesDriveView() {
  const wrap = rEl('div');
  for (const h of rideSummaryPending(rides.history, rides.summarySeen, 'driver')) wrap.append(ridesSummaryCard(h));   // F13
  if (rides.profile && !rides.profile.car) wrap.append(ridesCarPrompt());
  const payCard = ridesPayDriverCard();
  if (payCard) wrap.append(payCard);
  const mine = rides.myOffers.filter(o => o.status === 'accepted' || o.status === 'pending');
  const declined = ridesDeclinedList();                                   // F12
  if (mine.length || declined.length) {
    wrap.append(rEl('h3', { class: 'r-h3', text: 'Tavi piedāvājumi' }));
    for (const o of mine) wrap.append(ridesMyOfferCard(o));
    for (const o of declined) wrap.append(ridesDeclinedCard(o));
  }
  const route = state.nav.route;
  const along = state.nav.active && state.nav.along != null ? state.nav.along : 0;
  const offered = new Set(rides.myOffers.map(o => o.request_id));
  const list = rideListForDriver(rides.openList, { route, along, me: state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng }, myId: rides.store.id })
    .filter(x => !offered.has(x.req.id));
  wrap.append(rEl('h3', { class: 'r-h3', text: route ? `Pa ceļam uz ${state.nav.dest ? state.nav.dest.name : 'galamērķi'}` : 'Cilvēki tuvumā (līdz 5 km)' }));
  if (!route) wrap.append(rEl('p', { class: 'fine', text: 'Padoms: izvēlies savu galamērķi — tad redzēsi tikai tos, kas brauc tajā pašā virzienā.' }));
  if (!list.length) wrap.append(rEl('p', { class: 'fine r-wait', text: 'Pašlaik neviens negaida brauciena. Saraksts atjaunojas pats.' }));
  for (const x of list) wrap.append(ridesOpenCard(x));
  ridesMarkers(list.map(x => x.req));
  return wrap;
}
function ridesEtaMin(r) {
  if (!state.me) return null;
  const d = rideDist(state.me.lat, state.me.lng, r.from_lat, r.from_lng) * 1.3;   // pa ceļiem nedaudz garāk
  return Math.max(1, Math.round(d / 8.3 / 60));
}
function ridesOpenCard(x) {
  const r = x.req;
  const cap = rideFareCapCents(r);
  const price = rEl('input', { class: 'r-input r-price', type: 'text', inputmode: 'decimal', maxlength: 6, placeholder: '0', 'aria-label': 'Cena eiro' });
  if (rides.priceDraft && rides.priceDraft[r.id]) price.value = rides.priceDraft[r.id];
  price.addEventListener('input', () => { (rides.priceDraft || (rides.priceDraft = {}))[r.id] = price.value; });
  const msg = rEl('p', { class: 'r-msg', hidden: '' });     // ziņa tieši kartītē (statusa josla ir aiz loga)
  const meta = [rideTimeText(r.depart_at), r.seats + ' cilv.',
    x.match ? `+${x.match.detourMin} min apkārtceļš` : x.dist != null ? rideDistText(x.dist) + ' no tevis' : ''].filter(Boolean).join(' · ');
  return rEl('div', { class: 'r-card' },
    ridesPerson(r.passenger, '', meta, r.user_id),
    ridesRoute(r),
    r.note ? rEl('p', { class: 'r-note', text: '“' + r.note + '”' }) : null,
    rEl('label', { class: 'r-price-row' },
      rEl('span', { text: `Cena (neobligāti, līdz ${rideMoney(cap)})` }),
      rEl('span', { class: 'r-price-box' }, price, rEl('b', { text: '€' }))),
    rEl('div', { class: 'r-actions' },
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Kartē', onclick: () => { map.easeTo({ center: [r.from_lng, r.from_lat], zoom: 15 }); } }),
      rEl('button', { class: 'btn primary', type: 'button', text: 'Paņemšu', onclick: async e => {
        const say = (text, bad = true) => { msg.textContent = text; msg.className = 'r-msg' + (bad ? ' bad' : ''); msg.hidden = false; setStatus(text); };
        const cents = rideParsePrice(price.value);
        if (Number.isNaN(cents)) { say('Cenu ieraksti skaitļos, piem. 4,50'); price.focus(); return; }
        if (cents != null && cents > cap) { say(`Cena var būt līdz ${rideMoney(cap)}.`); price.focus(); return; }
        if (cents != null && cents > 0 && cents < 100) { say('Mazākā cena ir 1 €.'); price.focus(); return; }
        const btn = e.currentTarget;
        btn.disabled = true; say('Sūta piedāvājumu…', false);
        try {
          await rides.store.offer(r.id, { eta_min: ridesEtaMin(r), price_cents: cents || null });
          if (rides.priceDraft) delete rides.priceDraft[r.id];
          say('✓ Piedāvājums nosūtīts — gaidi pasažiera atbildi.', false);
        } catch (err) {
          console.warn(err);
          const t = String(err && err.message || '');
          say(/ 409 |23505|duplicate/.test(t) ? 'Tu šim braucienam jau esi piedāvājis (vai pasažieris to atteica).'
            : /pārsniedz/.test(t) ? `Cena pārsniedz maksimālo (${rideMoney(cap)}).`
            : 'Neizdevās nosūtīt piedāvājumu — pārbaudi internetu un mēģini vēlreiz.');
          btn.disabled = false;
          return;
        }
        ridesRefresh(true);
      } })),
    msg);
}
function ridesMyOfferCard(o) {
  const r = o.request, ok = o.status === 'accepted', st = rideStage(o);
  const badge = !ok ? 'Gaida pasažiera atbildi' : { matched: 'Pasažieris gaida tevi', coming: 'Brauc pakaļ', arrived: 'Esi klāt', onboard: 'Ceļā' }[st] || 'Pasažieris gaida tevi';
  const card = rEl('div', { class: 'r-card' + (ok ? ' r-ok' : '') },
    rEl('div', { class: 'r-card-top' },
      rEl('span', { class: 'r-badge', text: badge }),
      rEl('span', { class: 'r-when', text: rideTimeText(r.depart_at) })),
    ridesPerson(o.passenger, ok ? o.phone : '', '', r.user_id),
    ridesRoute(r));
  if (ok) card.append(rEl('p', { class: 'r-trip', id: 'trip-' + o.id, text: rideDriverStatus(o, state.me) }));
  if (o.price_cents) card.append(ridesDriverPayLine(o, ok));
  const acts = rEl('div', { class: 'r-actions' });
  if (st !== 'onboard') acts.append(rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt', onclick: async e => {
    e.currentTarget.disabled = true;
    await rides.store.cancelOffer(o.id);
    if (ok) await ridesRefundAfterCancel(o);              // samaksāts ar karti → automātiska atmaksa
    ridesRefresh(true);
  } }));
  acts.append(ridesChatBtn(o.id, (o.passenger && o.passenger.name) || 'Pasažieris'));
  const step = (text, fn) => acts.append(rEl('button', { class: 'btn primary', type: 'button', text, onclick: async e => {
    e.target.disabled = true;
    // F9: kļūda — uznirstošā ziņa (kartīte pēc ridesRefresh tiek pārzīmēta, ziņa tajā pazustu)
    try { await fn(); } catch (err) { console.warn(err); ridesToast('Neizdevās — pārbaudi internetu un mēģini vēlreiz.', true); }
    ridesRefresh(true);
  } }));
  const pickup = { name: 'Pasažieris: ' + ((o.passenger && o.passenger.name) || ''), sub: r.from_name, lat: r.from_lat, lng: r.from_lng };
  const dest = { name: r.to_name || 'Galamērķis', sub: 'Pasažiera galamērķis', lat: r.to_lat, lng: r.to_lng };
  const pos = () => state.me ? { lat: state.me.lat, lng: state.me.lng, heading: state.heading ?? null } : {};
  if (st === 'matched') step('Braukt pakaļ', async () => {
    await rides.store.driverUpdate(o.id, { trip: 'coming', ...pos() });
    ridesOpen(false); await ridesNavigate(o.pas_lat != null && rideFresh(o.pas_at, Date.now(), 180000) ? { ...pickup, lat: o.pas_lat, lng: o.pas_lng } : pickup);
  });
  if (st === 'coming') {
    acts.append(rEl('button', { class: 'btn ghost', type: 'button', text: 'Navigācija', onclick: () => { ridesOpen(false); ridesNavigate(pickup); } }));
    step('Esmu klāt', () => rides.store.driverUpdate(o.id, { trip: 'arrived', ...pos() }));
  }
  if (st === 'arrived') step('Pasažieris iekāpa', async () => {
    await rides.store.driverUpdate(o.id, { trip: 'onboard', ...pos() });
    ridesOpen(false); await ridesNavigate(dest);
  });
  if (st === 'onboard') {
    acts.append(rEl('button', { class: 'btn ghost', type: 'button', text: 'Navigācija', onclick: () => { ridesOpen(false); ridesNavigate(dest); } }));
    step('Brauciens pabeigts', async () => {
      await rides.store.driverUpdate(o.id, { trip: 'done' });
      if (state.nav.active) endNav();
      ridesHistoryAddLocal(rideHistoryFromOffer(o, r, 'driver', o.passenger));   // F13: kopsavilkums uzreiz
      ridesToast('Brauciens pabeigts. Paldies!');
    });
  }
  card.append(acts);
  return card;
}
// ---------- F12: noraidīts piedāvājums — šoferis redz, kāpēc tas pazūd ----------
function ridesDeclinedList() { return rideDeclinedRecent(rides.myOffers, rides.declOk, rides.declSeen); }
// Ja datubāzē vēl nav responded_at — atceras brīdi, kad gaidošais piedāvājums kļuva noraidīts
function ridesDeclinedTrack(wasPending) {
  let changed = false;
  for (const o of rides.myOffers) {
    if (o.status === 'declined' && !o.responded_at && wasPending.has(o.id) && !rides.declSeen[o.id]) { rides.declSeen[o.id] = Date.now(); changed = true; }
  }
  const cut = Date.now() - RIDE_DECLINED_SHOW_MS;
  for (const [id, t] of Object.entries(rides.declSeen)) if (t < cut) { delete rides.declSeen[id]; changed = true; }
  if (changed) try { localStorage.setItem('cz.rides.declSeen', JSON.stringify(rides.declSeen)); } catch { /* */ }
}
function ridesDeclinedOk(id) {
  if (!rides.declOk.includes(id)) rides.declOk = rides.declOk.concat(id).slice(-50);
  try { localStorage.setItem('cz.rides.declOk', JSON.stringify(rides.declOk)); } catch { /* */ }
  ridesRender(true);
}
function ridesDeclinedCard(o) {
  const r = o.request || {};
  return rEl('div', { class: 'r-card r-declined', role: 'status' },
    rEl('div', { class: 'r-card-top' },
      rEl('span', { class: 'r-badge', text: 'Piedāvājums noraidīts' }),
      rEl('span', { class: 'r-when', text: rideTimeText(r.depart_at) })),
    ridesPerson(o.passenger, '', ''),
    ridesRoute(r),
    rEl('p', { class: 'r-declined-msg', text: rideDeclinedText(o) }),
    rEl('div', { class: 'r-actions' }, rEl('button', { class: 'btn ghost', type: 'button', text: 'Labi', onclick: () => ridesDeclinedOk(o.id) })));
}
// ---------- Kartes maksājumi (Stripe caur servera funkciju ride-pay) ----------
function ridesPayOn() { return !!(rides.store && rides.store.pay) && !(rides.payCfg && rides.payCfg.off); }
function ridesPayIds() {
  const ids = [];
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) if (o.status === 'accepted' && o.price_cents) ids.push(o.id);
  for (const o of rides.myOffers) if (o.status === 'accepted' && o.price_cents) ids.push(o.id);
  return ids;
}
// F11: cik reižu šofera gatavību neizdevās noskaidrot (Stripe neatbild) — pēc 2 reizēm poga tomēr redzama (serveris pārbauda pats)
function ridesPayDrvMiss(ids) { for (const id of ids) rides.payDrvTries[id] = (rides.payDrvTries[id] || 0) + 1; }
async function ridesPayRefresh(force) {
  if (!ridesPayOn()) return;
  const ids = ridesPayIds();
  if (!ids.length || (!force && Date.now() - rides.payAt < 20000)) return;
  rides.payAt = Date.now();
  try {
    const j = await rides.store.pay('status', { offer_ids: ids });
    rides.pay = j.pay || {}; rides.payCfg = { test: !!j.test, fee_pct: j.fee_pct ?? RIDE_FEE_PCT };
    rides.payDrvOk = Object.assign({}, rides.payDrvOk, j.drv || {});   // F11: šofera gatavība (true / false)
    ridesPayDrvMiss(ids.filter(id => !(j.drv && id in j.drv)));
  } catch (e) { if (e.status === 503) rides.payCfg = { off: true }; else console.warn('Maksājumi', e); ridesPayDrvMiss(ids); }
}
async function ridesPayDriverLoad() {
  if (rides.payDrvBusy || !ridesPayOn()) return;
  rides.payDrvBusy = true;
  try {
    const j = await rides.store.pay('driver_status');
    rides.payDrv = j; rides.payCfg = { test: !!j.test, fee_pct: j.fee_pct ?? RIDE_FEE_PCT };
  } catch (e) { rides.payDrv = { error: true }; if (e.status === 503) rides.payCfg = { off: true }; }
  rides.payDrvBusy = false;
  ridesRender();
}
function ridesFeePct() { return rides.payCfg && rides.payCfg.fee_pct != null ? rides.payCfg.fee_pct : RIDE_FEE_PCT; }
function ridesTestNote() {
  return rides.payCfg && rides.payCfg.test ? rEl('p', { class: 'r-pay-test', text: 'TESTA REŽĪMS — īsta nauda netiek ņemta. Izmanto testa karti 4242 4242 4242 4242, jebkuru nākotnes datumu un jebkuru CVC.' }) : null;
}
function ridesReturnUrl() { return location.origin + location.pathname; }
// Šoferim: pieslēgt maksājumu saņemšanu
function ridesPayDriverCard() {
  if (!ridesPayOn()) return null;
  if (!rides.payDrv) { ridesPayDriverLoad(); return rEl('div', { class: 'r-pay-card' }, rEl('p', { class: 'fine', text: 'Pārbaudu kartes maksājumus…' })); }
  const d = rides.payDrv;
  if (d.error) return null;
  const pct = ridesFeePct();
  // Jaunam kontam Stripe vajag e-pastu (izmaksu paziņojumiem)
  const email = d.connected ? null : rEl('input', { class: 'r-input', id: 'rpPayEmail', type: 'email', autocomplete: 'email', maxlength: 120, placeholder: 'tavs@epasts.lv' });
  if (email && rides.payEmail) email.value = rides.payEmail;
  const msg = ridesCardMsg('connect');                       // F9: ziņa kartītē pie lauka / pogas
  if (email && rides.cardMsg && rides.cardMsg.connect && rides.cardMsg.connect.field) email.setAttribute('aria-invalid', 'true');
  if (email) email.addEventListener('input', () => {
    rides.payEmail = email.value;
    if (email.getAttribute('aria-invalid')) { email.removeAttribute('aria-invalid'); ridesSay('connect', msg, ''); }   // sāk rakstīt — ziņa pazūd
  });
  const go = async e => {
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.value.trim())) {
      ridesSay('connect', msg, 'Ieraksti savu e-pastu.', true, true); email.setAttribute('aria-invalid', 'true'); email.focus(); return;
    }
    const btn = e.currentTarget;
    btn.disabled = true; ridesSay('connect', msg, '');
    try { const j = await rides.store.pay('connect', { return_url: ridesReturnUrl(), email: email ? email.value.trim() : '' }); location.href = j.url; }
    catch (err) { ridesSay('connect', msg, err.message || 'Neizdevās atvērt pieslēgšanu.'); btn.disabled = false; }
  };
  const box = rEl('div', { class: 'r-pay-card' + (d.ready ? ' r-pay-ready' : '') },
    rEl('div', { class: 'r-pay-head' }, rEl('b', { text: '💳 Kartes maksājumi' }), rides.payCfg && rides.payCfg.test ? rEl('span', { class: 'r-pay-badge', text: 'TESTS' }) : null));
  if (d.ready) box.append(rEl('p', { class: 'r-pay-txt', text: `Pasažieri var tev samaksāt ar karti. Tu saņem cenu mīnus ${pct} % lietotnes komisija — nauda nonāk tavā bankas kontā caur Stripe.` }));
  else {
    box.append(rEl('p', { class: 'r-pay-txt', text: d.connected
      ? 'Pieslēgšana nav pabeigta — Stripe vēl vajag dažus datus.'
      : `Lai pasažieri var samaksāt ar karti tieši lietotnē, pieslēdz maksājumu saņemšanu. Datus un bankas kontu pārbauda Stripe; tu saņem cenu mīnus ${pct} % komisija.` }));
    if (email) box.append(rEl('label', { class: 'r-label', for: 'rpPayEmail', text: 'Tavs e-pasts (uz to Stripe sūtīs paziņojumus par izmaksām)' }), email, msg);   // ziņa zem lauka
    box.append(rEl('button', { class: 'btn primary', type: 'button', text: d.connected ? 'Turpināt pieslēgšanu' : 'Pieslēgt maksājumus', onclick: go }));
    if (!email) box.append(msg);
  }
  return box;
}
// Šoferim: cena un vai samaksāts
function ridesDriverPayLine(o, ok) {
  const { driver } = rideSplit(o.price_cents, ridesFeePct());
  const p = rides.pay[o.id];
  const text = `Cena ${rideMoney(o.price_cents)}` + (ridesPayOn() ? ` · ar karti tu saņem ${rideMoney(driver)}` : '');
  const line = rEl('div', { class: 'r-pay-line' + (p && p.paid && !p.refunded ? ' r-paid' : '') },
    rEl('span', { text }),
    ok && p && p.refunded ? rEl('b', { class: 'r-refunded', text: '↩ Atmaksāts ' + rideMoney(p.refund_cents || p.amount || o.price_cents) })
      : ok && p && p.paid ? rEl('b', { text: '✓ Samaksāts ar karti' })
      : ok ? rEl('small', { text: 'Vēl nav samaksāts (var arī skaidrā)' }) : null);
  if (!(ok && p && p.paid && !p.refunded)) return line;
  return rEl('div', { class: 'r-pay-wrap' }, line, ridesRefundBtn(o, p));
}
// ---------- Atmaksa (F14): šofera poga „Atmaksāt” ----------
function ridesRefundBtn(o, p) {
  const amount = p.amount || o.price_cents;
  const msg = rEl('p', { class: 'r-msg', hidden: '' });             // ziņa tieši kartītē (statusa josla ir aiz loga)
  const say = (t, bad = true) => { msg.textContent = t; msg.className = 'r-msg' + (bad ? ' bad' : ''); msg.hidden = !t; };
  const wrap = rEl('div', { class: 'r-refund' });
  const btn = rEl('button', { class: 'btn ghost small r-refund-btn', type: 'button', text: 'Atmaksāt', onclick: () => {
    btn.hidden = true;
    const box = rEl('div', { class: 'r-confirm' },
      rEl('span', { text: `Atmaksāt pasažierim ${rideMoney(amount)}? Šo nevar atsaukt.` }),
      rEl('button', { class: 'link-btn', type: 'button', text: 'Nē', onclick: () => { box.remove(); btn.hidden = false; } }),
      rEl('button', { class: 'btn danger small', type: 'button', text: 'Jā, atmaksāt', onclick: async e => {
        e.currentTarget.disabled = true; say('Atmaksā…', false);
        try {
          const r = await rides.store.pay('refund', { offer_id: o.id });
          ridesRefundSeen(o.id);
          rides.pay[o.id] = { ...p, refunded: true, refund_cents: r.amount || amount };
          box.remove();
          say(`✓ Atmaksāts pasažierim ${rideMoney(r.amount || amount)}. Nauda un lietotnes komisija atgriezta no tava Stripe konta.`, false);
          const line = wrap.parentElement && wrap.parentElement.querySelector('.r-pay-line b');
          if (line) { line.textContent = '↩ Atmaksāts ' + rideMoney(r.amount || amount); line.className = 'r-refunded'; }
        } catch (err) {
          say(err.message || 'Atmaksa neizdevās — mēģini vēlreiz.');
          box.remove(); btn.hidden = false;
        }
      } }));
    wrap.insertBefore(box, msg);
  } });
  wrap.append(btn, msg);
  return wrap;
}
// Atcelts brauciens, kas, iespējams, samaksāts ar karti → tā pati servera darbība „refund” (auto: serveris pats pārbauda,
// ka brauciens atcelts pirms iekāpšanas un tiešām samaksāts). Paziņojums — uznirstošs, jo kartīte pēc atcelšanas pazūd.
async function ridesRefundAfterCancel(o) {
  if (!o || !o.price_cents || !ridesPayOn()) return;
  try {
    const r = await rides.store.pay('refund', { offer_id: o.id, auto: true });
    if (r && r.refunded && !r.already) {
      ridesRefundSeen(o.id);
      const sum = rideMoney(r.amount || o.price_cents);
      ridesToast(o.driver_id === rides.store.id
        ? `Brauciens atcelts. Pasažierim automātiski atmaksāti ${sum}.`
        : `Nauda ${sum} atmaksāta uz tavu karti. Bankā tā parādīsies 5–10 darba dienu laikā.`);
    }
  } catch (e) {
    if (e.status === 409) return;                        // nebija samaksāts ar karti — nav ko atmaksāt
    ridesToast('Atmaksa vēl nav izdevusies — lietotne mēģinās vēlreiz automātiski.', true);   // refund_sync to pabeigs
  }
}
// Atverot „Kopā” (ne biežāk kā ik 10 min; atceļot — uzreiz): pabeidz neizdevušās automātiskās atmaksas un paziņo par jaunām atmaksām
async function ridesRefundSync() {
  if (!ridesPayOn() || Date.now() - (rides.refundAt || 0) < 600000) return;
  rides.refundAt = Date.now();
  let j;
  try { j = await rides.store.pay('refund_sync'); } catch (e) { if (e.status === 503) rides.payCfg = { off: true }; return; }
  const seen = ridesRefundSeenList();
  for (const x of (j && j.recent) || []) {
    if (seen.includes(x.offer_id)) continue;
    ridesRefundSeen(x.offer_id);
    const sum = rideMoney(x.refund_cents || 0);
    ridesToast(x.role === 'passenger'
      ? `Nauda ${sum} atmaksāta uz tavu karti. Bankā tā parādīsies 5–10 darba dienu laikā.`
      : `Pasažierim atmaksāti ${sum}` + (x.refund_reason === 'cancelled_before_pickup' ? ' (brauciens atcelts pirms iekāpšanas).' : '.'));
  }
}
function ridesRefundSeenList() { try { return JSON.parse(localStorage.getItem('cz.rides.refundSeen') || '[]'); } catch { return []; } }
function ridesRefundSeen(id) {
  const l = ridesRefundSeenList(); if (l.includes(id)) return;
  l.push(id); try { localStorage.setItem('cz.rides.refundSeen', JSON.stringify(l.slice(-50))); } catch { /* */ }
}
// F9: ziņa tieši kartītē pie pogas / lauka. Teksts glabājas rides.cardMsg, lai to neizdzēš loga pārzīmēšana.
function ridesCardMsg(key) {
  const m = rides.cardMsg && rides.cardMsg[key];
  return rEl('p', { class: 'r-msg' + (m && m.bad ? ' bad' : ''), role: 'alert', 'aria-live': 'polite', hidden: m ? null : true, text: m ? m.text : null });
}
function ridesSay(key, el, text, bad = true, field = false) {
  const all = rides.cardMsg || (rides.cardMsg = {});
  if (text) all[key] = { text, bad, field }; else delete all[key];
  el.textContent = text || ''; el.className = 'r-msg' + (bad ? ' bad' : ''); el.hidden = !text;
  if (text) try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* */ }
}
function ridesToast(text, loud) { if (typeof czToast === 'function') czToast(text, loud); else if (typeof parkToast === 'function') parkToast(text, loud); }
// Pasažierim: maksāt ar karti
function ridesPassengerPay(o) {
  if (!o.price_cents) return null;
  const p = rides.pay[o.id];
  const box = rEl('div', { class: 'r-pay-line' + (p && p.paid && !p.refunded ? ' r-paid' : '') }, rEl('span', { text: 'Cena ' + rideMoney(o.price_cents) }));
  if (p && p.refunded) {
    const sum = rideMoney(p.refund_cents || p.amount || o.price_cents);
    box.append(rEl('b', { class: 'r-refunded', text: '↩ Atmaksāts ' + sum }));
    return rEl('div', { class: 'r-pay-wrap' }, box, rEl('p', { class: 'fine', text: `Nauda ${sum} atmaksāta uz tavu karti. Bankā tā parādīsies 5–10 darba dienu laikā.` }));
  }
  if (p && p.paid) { box.append(rEl('b', { text: '✓ Samaksāts ar karti' })); return box; }
  if (!ridesPayOn()) { box.append(rEl('small', { text: 'Samaksā šoferim, kā vienojāties.' })); return box; }
  const msg = ridesCardMsg('pay:' + o.id);                  // F9 (arī F11): kļūda kartītē pie pogas
  // F11: pogu rāda tikai, ja šoferim kartes maksājumi ir gatavi
  const drvOk = rides.payDrvOk[o.id];
  if (drvOk === false) { box.append(rEl('small', { text: 'Šoferis pieņem tikai skaidru naudu' })); return rEl('div', { class: 'r-pay-wrap' }, box, msg); }
  if (drvOk !== true && (rides.payDrvTries[o.id] || 0) < 2) { box.append(rEl('small', { text: 'Pārbaudu kartes maksājumus…' })); return box; }
  const btn = rEl('button', { class: 'btn primary r-pay-btn', type: 'button', text: 'Maksāt ar karti', onclick: async e => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Atveru…'; ridesSay('pay:' + o.id, msg, '');
    try { const j = await rides.store.pay('checkout', { offer_id: o.id, return_url: ridesReturnUrl() }); location.href = j.url; }
    catch (err) {
      ridesSay('pay:' + o.id, msg, err.message || 'Neizdevās atvērt maksājumu.'); b.disabled = false; b.textContent = 'Maksāt ar karti';
      // F11: šoferis atvienoja maksājumus pēc kartītes atvēršanas — pārslēdz uz skaidru naudu (ziņa paliek kartītē)
      if (err.status === 409 && /Šoferis/.test(err.message || '')) { rides.payDrvOk[o.id] = false; ridesRender(true); }
    }
  } });
  const wrap = rEl('div', { class: 'r-pay-wrap' }, box, btn, msg);
  const t = ridesTestNote(); if (t) wrap.append(t);
  return wrap;
}
// Atgriešanās no Stripe lapas (?pay=ok / cancel / connected / connect-retry)
function ridesPayReturn() {
  const q = new URLSearchParams(location.search), v = q.get('pay');
  if (!v) return;
  q.delete('pay');
  try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch { /* */ }
  const msg = { ok: 'Paldies! Maksājums pieņemts.', cancel: 'Maksājums atcelts — nauda netika ņemta.',
    connected: 'Atpakaļ no Stripe — pārbaudu maksājumu pieslēgšanu…', 'connect-retry': 'Saite novecoja — nospied „Turpināt pieslēgšanu” vēlreiz.' }[v];
  if (v === 'connected' || v === 'connect-retry') { rides.payDrv = null; if (rides.tab !== 'drive') ridesTab('drive'); }
  ridesOpen(true);
  if (msg) ridesToast(msg, v === 'cancel' || v === 'connect-retry');   // F9: logs uzreiz atveras — ziņa virs tā
  if (v === 'ok') { rides.payAt = 0; ridesRefresh(false); }
}

// Šofera navigācija uz pasažieri / galamērķi: maršruts uzreiz un navigācija sākas.
async function ridesNavigate(place) {
  if (state.nav.active) endNav();
  await selectDestination(place);
  if (state.nav.route) startNav();
}

// ---------- Čats ----------
function ridesChatBtn(offerId, name) {
  const n = ridesUnread(offerId);
  return rEl('button', { class: 'btn ghost r-chat-btn', type: 'button', onclick: () => ridesOpenChat(offerId, name) },
    'Čats', n ? rEl('span', { class: 'r-unread', text: n }) : null);
}
function ridesOpenChat(offerId, name) {
  rides.chat = { offerId, name, shown: 0 };
  ridesMarkSeen(offerId);
  ridesRender(true);
  ridesSchedule();
}
function ridesCloseChat() { rides.chat = null; ridesRender(true); }
const RIDE_QUICK = ['Esmu ceļā', 'Būšu pēc 5 min', 'Esmu klāt', 'Kur tu esi?', 'Paldies!'];
function ridesChatView() {
  const c = rides.chat;
  const input = rEl('input', { class: 'r-input r-chat-input', id: 'rcInput', maxlength: 500, placeholder: 'Raksti ziņu…', autocomplete: 'off', enterkeyhint: 'send' });
  const send = async text => {
    text = (text ?? input.value).trim();
    if (!text) return;
    if (text === input.value.trim()) input.value = '';
    const list = $('rcList');
    const tmp = rEl('div', { class: 'r-msg mine sending' }, rEl('span', { text }));
    if (list) { list.append(tmp); list.scrollTop = list.scrollHeight; }
    try {
      await rides.store.send(c.offerId, text);
      const have = rides.msgs[c.offerId] || [];
      const fresh = await rides.store.messages(c.offerId, have.length ? have[have.length - 1].id : 0);
      rides.msgs[c.offerId] = have.concat(fresh || []);
      tmp.remove(); ridesChatUpdate();
    } catch (err) { console.warn(err); tmp.classList.add('failed'); tmp.title = 'Neizdevās nosūtīt'; }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  rides.chat.shown = 0;
  return rEl('div', { class: 'r-chat' },
    rEl('div', { class: 'r-chat-head' },
      rEl('button', { class: 'link-btn', type: 'button', text: '← Atpakaļ', onclick: ridesCloseChat }),
      rEl('strong', { text: c.name })),
    rEl('div', { class: 'r-chat-list', id: 'rcList' }),
    rEl('div', { class: 'r-quick' }, ...RIDE_QUICK.map(q => rEl('button', { type: 'button', class: 'r-chip', text: q, onclick: () => send(q) }))),
    rEl('div', { class: 'r-chat-form' }, input, rEl('button', { class: 'btn primary', type: 'button', text: 'Sūtīt', onclick: () => send() })),
    rEl('p', { class: 'fine', text: 'Ziņas redz tikai jūs abi. Neraksti paroles vai bankas datus.' }));
}
// Pievieno tikai jaunās ziņas (ievades lauks netiek aiztikts).
function ridesChatUpdate() {
  const c = rides.chat, list = $('rcList');
  if (!c || !list) return;
  const msgs = rides.msgs[c.offerId] || [];
  if (!msgs.length && !list.childNodes.length) list.append(rEl('p', { class: 'fine r-chat-empty', text: 'Vēl nav ziņu. Uzraksti pirmais!' }));
  if (msgs.length && list.querySelector('.r-chat-empty')) list.replaceChildren();
  for (const m of msgs.slice(c.shown)) {
    list.append(rEl('div', { class: 'r-msg ' + (m.sender === rides.store.id ? 'mine' : 'theirs') },
      rEl('span', { text: m.body }), rEl('small', { text: rideMsgTime(m.created_at) })));
  }
  if (msgs.length > c.shown) { c.shown = msgs.length; list.scrollTop = list.scrollHeight; ridesMarkSeen(c.offerId); }
}

// ---------- Brauciena gaita kartē ----------
// Pasažieris redz šofera auto un maršrutu (līdz sev, pēc iekāpšanas — līdz galamērķim);
// šoferis redz, kur gaida pasažieris. Paša navigācija paliek kā ir.
function ridesLiveText() {
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) {
    const L = rides.live, st = rideStage(o);
    const eta = L.route && L.routeFor === o.id && L.routeStage === st && L.route.duration ? clockIn(L.route.duration) : null;
    const el = document.getElementById('trip-' + o.id);
    if (el) el.textContent = ridePassengerStatus(o, r) + (eta ? (st === 'coming' ? ` · būs pie tevis ~${eta}` : ` · galamērķī ~${eta}`) : '');
  }
  for (const o of rides.myOffers) { const el = document.getElementById('trip-' + o.id); if (el) el.textContent = rideDriverStatus(o, state.me); }
}
function ridesCarSvg() {
  return '<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#2f9e44" stroke="#fff" stroke-width="2.5"/><path d="M9 19.5v-3.2l2-4.8c.3-.7 1-1.2 1.8-1.2h6.4c.8 0 1.5.5 1.8 1.2l2 4.8v3.2c0 .6-.4 1-1 1h-.8a1 1 0 0 1-1-1v-.8h-8.4v.8a1 1 0 0 1-1 1H10c-.6 0-1-.4-1-1Zm2.6-4h8.8l-1.3-3.1a.6.6 0 0 0-.5-.4h-5.2a.6.6 0 0 0-.5.4Z" fill="#fff"/></svg>';
}
function ridesEnsureLayer() {
  if (!map || !map.getStyle || map.getSource('ride-live')) return;
  map.addSource('ride-live', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ride-live-line', type: 'line', source: 'ride-live', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2f9e44', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8], 'line-opacity': 0.85, 'line-dasharray': [1.2, 1.2] } });
}
function ridesSetMarker(key, lngLat, html, cls) {
  const L = rides.live;
  if (!lngLat) { if (L[key]) { L[key].remove(); L[key] = null; } return; }
  if (!L[key]) { const el = rEl('div', { class: cls }); el.innerHTML = html; L[key] = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map); }
  else L[key].setLngLat(lngLat);
}
async function ridesLiveMap() {
  if (!map || typeof maplibregl === 'undefined') return;
  const trip = ridesActiveTrip();
  const L = rides.live;
  const clear = () => {
    ridesSetMarker('carMarker', null); ridesSetMarker('pasMarker', null); ridesSetMarker('destMarker', null);
    const src = map.getSource && map.getSource('ride-live'); if (src) src.setData({ type: 'FeatureCollection', features: [] });
    L.route = null; L.routeKey = '';
  };
  if (!trip) return clear();
  const o = trip.o, r = trip.req, st = rideStage(o);
  if (trip.role === 'driver') {
    // Šoferim: kur stāv pasažieris (ja dalās ar atrašanās vietu), līdz iekāpšanai
    const fresh = o.pas_lat != null && rideFresh(o.pas_at, Date.now(), 180000) && (st === 'coming' || st === 'arrived' || st === 'matched');
    ridesSetMarker('pasMarker', fresh ? [o.pas_lng, o.pas_lat] : null, '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="7.5" r="3.6" fill="#fff"/><path d="M5 20c.6-4.2 3.3-6.6 7-6.6s6.4 2.4 7 6.6Z" fill="#fff"/></svg>', 'ride-marker ride-pas-live');
    ridesSetMarker('carMarker', null); ridesSetMarker('destMarker', null);
    return;
  }
  // Pasažierim
  const drvOk = o.drv_lat != null && rideFresh(o.drv_at);
  ridesSetMarker('carMarker', drvOk && st !== 'matched' ? [o.drv_lng, o.drv_lat] : null, ridesCarSvg(), 'ride-car');
  ridesSetMarker('destMarker', st === 'arrived' || st === 'onboard' ? [r.to_lng, r.to_lat] : null,
    '<svg viewBox="0 0 36 46" width="28" height="36"><path d="M18 1C8.6 1 1 8.4 1 17.6 1 30.2 18 45 18 45s17-14.8 17-27.4C35 8.4 27.4 1 18 1Z" fill="#2f9e44" stroke="#fff" stroke-width="2"/><circle cx="18" cy="17" r="6.5" fill="#fff"/></svg>', 'ride-dest');
  // Maršruts: šoferis → pasažieris (brauc pakaļ) vai → galamērķis (ir klāt / ceļā)
  let from = null, to = null;
  if (st === 'coming' && drvOk) { from = { lat: o.drv_lat, lng: o.drv_lng }; to = { lat: r.from_lat, lng: r.from_lng }; }
  if (st === 'arrived' || st === 'onboard') { from = drvOk ? { lat: o.drv_lat, lng: o.drv_lng } : { lat: r.from_lat, lng: r.from_lng }; to = { lat: r.to_lat, lng: r.to_lng }; }
  if (!from) { const src = map.getSource && map.getSource('ride-live'); if (src) src.setData({ type: 'FeatureCollection', features: [] }); L.route = null; return; }
  const key = o.id + st + to.lat.toFixed(5) + to.lng.toFixed(5);
  const moved = L.routeFrom ? rideDist(L.routeFrom.lat, L.routeFrom.lng, from.lat, from.lng) : Infinity;
  if (key !== L.routeKey || Date.now() - L.routeAt > 60000 || moved > 400) {
    L.routeKey = key; L.routeAt = Date.now(); L.routeFrom = from;
    try {
      const route = await requestRoute(from, to);
      L.route = route; L.routeFor = o.id; L.routeStage = st;
      ridesEnsureLayer();
      map.getSource('ride-live').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: {} });
      ridesLiveText();
    } catch (err) { console.warn('Brauciena maršruts nav ielādēts', err); }
  }
}
function ridesShowTripOnMap() {
  const trip = ridesActiveTrip();
  ridesOpen(false);
  if (!trip) return;
  const o = trip.o, r = trip.req, pts = [[r.from_lng, r.from_lat]];
  if (o.drv_lat != null) pts.push([o.drv_lng, o.drv_lat]);
  if (rideStage(o) === 'onboard' || rideStage(o) === 'arrived') pts.push([r.to_lng, r.to_lat]);
  if (rides.live.route) for (const c of rides.live.route.coords) pts.push(c);
  state.follow = false;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 160, bottom: 140, left: 50, right: 90 }, maxZoom: 16, duration: 800 });
}

// Pasažieru vietas kartē (šofera cilnē).
function ridesMarkers(reqs) {
  for (const m of rides.markers) m.remove();
  rides.markers = [];
  if (!map || typeof maplibregl === 'undefined') return;
  for (const r of reqs) {
    const el = rEl('div', { class: 'ride-marker', title: (r.passenger && r.passenger.name) || 'Pasažieris' });
    el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="7.5" r="3.6" fill="#fff"/><path d="M5 20c.6-4.2 3.3-6.6 7-6.6s6.4 2.4 7 6.6Z" fill="#fff"/></svg>';
    rides.markers.push(new maplibregl.Marker({ element: el }).setLngLat([r.from_lng, r.from_lat]).addTo(map));
  }
}

async function ridesAddDemo() {
  const c = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  const route = state.nav.route;
  let near, to;
  if (route && route.coords.length > 4) {
    const a = route.coords[Math.floor(route.coords.length * 0.25)], b = route.coords[Math.floor(route.coords.length * 0.85)];
    near = { lat: a[1] + 0.0008, lng: a[0], name: 'Pa ceļam' }; to = { lat: b[1], lng: b[0], name: state.nav.dest ? state.nav.dest.name : 'Galamērķis' };
  } else {
    near = { lat: c.lat + 0.004, lng: c.lng + 0.003, name: 'Tuvumā' }; to = { lat: c.lat + 0.03, lng: c.lng + 0.05, name: 'Kaut kur tālāk' };
  }
  await rides.store.addDemoPassenger(near, to);
  ridesTab('drive'); ridesRefresh(false);
}

// ---------- Konts (F1): saglabāšana ar e-pastu / Google, pieslēgšanās, izrakstīšanās, dzēšana ----------
function ridesAccountBar() {
  const a = rides.store && rides.store.auth;
  if (!a || !a.hasSession()) return document.createDocumentFragment();
  const open = () => { rides.accountView = true; rides.accountMode = null; rides.accountMsg = null; ridesRender(true); };
  const hist = rides.profile ? rEl('button', { class: 'link-btn', type: 'button', text: 'Mani braucieni', onclick: ridesOpenHistory }) : null;   // F13
  const stats = rEl('button', { class: 'link-btn', type: 'button', text: 'Mana statistika', onclick: ridesOpenStats });   // F16
  if (a.isAnon) {
    return rEl('div', { class: 'r-acc-bar warn' },
      rEl('span', { text: '🔒 Konts saglabāts tikai šajā ierīcē' }),
      rEl('span', { class: 'r-acc-links' }, hist, stats, rEl('button', { class: 'link-btn', type: 'button', text: 'Saglabāt kontu', onclick: open })));
  }
  return rEl('div', { class: 'r-acc-bar' },
    rEl('span', { text: '✓ ' + (a.email || 'Pieslēdzies') }),
    rEl('span', { class: 'r-acc-links' }, hist, stats, rEl('button', { class: 'link-btn', type: 'button', text: 'Konts', onclick: open })));
}
// Atver konta skatu (arī no iestatījumiem)
function ridesOpenAccount() {
  rides.accountView = true; rides.accountMode = null; rides.accountMsg = null;
  ridesOpen(true);
  ridesRender(true);
}
function ridesAccountNote(t) {
  rides.accountView = true;
  rides.accountMsg = { text: `✓ Iepriekšējā konta dati pārcelti (${t.requests || 0} pieprasījumi, ${t.offers || 0} piedāvājumi, ${t.messages || 0} ziņas).`, bad: false };
}
// Atgriešanās no e-pasta saites vai Google
async function ridesAuthReturn() {
  const a = rides.store && rides.store.auth;
  if (!a || !a.handleReturn) return null;
  const h = location.hash, q = location.search;
  if (!/access_token=|error_code=|[#&?]error=|message=/.test(h + q)) return null;
  let res;
  try { res = await a.handleReturn(h, q); } catch (e) { console.warn(e); res = { ok: false, text: czAuthErrorText('network') }; }
  const u = new URL(location.href);
  for (const k of ['error', 'error_code', 'error_description']) u.searchParams.delete(k);
  history.replaceState(null, '', u.pathname + u.search);           // atslēgas no adreses joslas prom
  if (!res) return null;
  rides.accountView = true; rides.accountMode = null;
  if (!res.ok) { rides.accountMsg = { text: res.text, bad: true }; return res; }
  ridesSetSignedOut(false);
  if (res.message) { rides.accountMsg = { text: 'Apstiprinājums saņemts. Ja e-pastā ir vēl viena saite — atver arī to.', bad: false }; return res; }
  let t = res.type === 'email_change'
    ? `✓ Konts saglabāts. Tagad vari pieslēgties ar ${a.email} jebkurā ierīcē.`
    : `✓ Pieslēdzies kā ${a.email || 'Google konts'}.`;
  const tr = res.transfer;
  if (tr && tr.ok && !tr.same) {
    t += ` Šīs ierīces dati pārcelti (${tr.requests || 0} pieprasījumi, ${tr.offers || 0} piedāvājumi).`;
    if (tr.stripe === 'moved') { try { await rides.store.pay('adopt'); } catch { /* nākamreiz */ } }
    if (tr.stripe === 'duplicate') t += ' Abos kontos bija kartes maksājumu konts — saglabāts šī konta.';
  } else if (tr && !tr.ok) {
    t += ' Iepriekšējā konta datus pārcelt neizdevās — tie nav dzēsti. Vari atgriezties pie tā zemāk.';
  }
  rides.accountMsg = { text: t, bad: false };
  try { await a.syncTermsConsent(); } catch { /* */ }
  return res;
}
function ridesAccountView() {
  const a = rides.store.auth;
  const wrap = rEl('div', { class: 'r-account' });
  const msg = rEl('p', { class: 'r-msg' + (rides.accountMsg && rides.accountMsg.bad ? ' bad' : ''), hidden: !rides.accountMsg });
  if (rides.accountMsg) msg.textContent = rides.accountMsg.text;
  const say = (text, bad = true) => { rides.accountMsg = { text, bad }; msg.textContent = text; msg.className = 'r-msg' + (bad ? ' bad' : ''); msg.hidden = false; };
  const back = () => { rides.accountView = false; rides.accountMode = null; rides.accountMsg = null; ridesRefresh(false); ridesRender(true); };
  if (rides.providers == null) { rides.providers = {}; a.providers().then(p => { rides.providers = p || {}; ridesRender(true); }); }
  wrap.append(rEl('div', { class: 'r-acc-head' },
    rEl('button', { class: 'link-btn', type: 'button', text: '← Atpakaļ', onclick: back }),
    rEl('b', { text: 'Konts' })));
  if (a.hasSession() && rides.profile && rides.accountMode !== 'delete') wrap.append(ridesMyRatingRow());   // F13
  if (a.hasSession() && rides.accountMode !== 'delete') wrap.append(rEl('div', { class: 'r-stat-links' },        // F16
    rEl('button', { class: 'btn ghost', type: 'button', text: '📊 Mana statistika', onclick: () => { rides.accountView = false; rides.accountMsg = null; ridesOpenStats(); } }),
    rides.isAdmin ? rEl('button', { class: 'btn ghost', type: 'button', text: 'Statistika (īpašniekam)', onclick: () => { rides.accountView = false; rides.accountMsg = null; ridesOpenAdmin(); } }) : null));

  // E-pasta lauks + poga (mode: 'link' — saglabāt šo kontu; 'other' — pieslēgties citam kontam; 'signin' — pieslēgties)
  const emailForm = (mode, label) => {
    const inp = rEl('input', { class: 'r-input', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: 254, placeholder: 'tavs@epasts.lv', id: 'raEmail' });
    inp.value = rides.accountEmail || '';
    inp.addEventListener('input', () => { rides.accountEmail = inp.value; });
    const btn = rEl('button', { class: 'btn primary', type: 'button', text: label, onclick: async () => {
      const email = inp.value.trim();
      if (!czEmailOk(email)) { say('Ieraksti derīgu e-pasta adresi, piem. vards@epasts.lv'); inp.focus(); return; }
      btn.disabled = true; say('Sūta…', false);
      try {
        if (mode === 'other') await a.signInOther(email, czReturnUrl());
        else await a.sendLink(email, czReturnUrl());
        say(`✓ Saite nosūtīta uz ${email}. Atver e-pastu šajā ierīcē un nospied saiti (der 1 stundu). Nav? Pārbaudi mēstuļu mapi.`, false);
      } catch (e) {
        console.warn('Konts', e);
        if (mode === 'link' && /email_exists|already/.test(e.code || '')) { rides.accountMode = 'conflict'; ridesRender(true); return; }
        say(czAuthErrorText(e.code, e.status));
      } finally { btn.disabled = false; }
    } });
    return rEl('div', { class: 'r-acc-form' }, inp, btn);
  };
  const googleBtn = other => rides.providers && rides.providers.google
    ? rEl('button', { class: 'btn ghost r-google', type: 'button', text: 'Turpināt ar Google', onclick: async () => {
        try { location.href = await a.oauthUrl('google', czReturnUrl(), { other }); } catch (e) { say(czAuthErrorText(e.code, e.status)); }
      } }) : '';
  const legal = rEl('p', { class: 'fine r-acc-legal' },
    rEl('a', { href: 'terms.html', target: '_blank', rel: 'noopener', text: 'Lietošanas noteikumi' }), ' · ',
    rEl('a', { href: 'privacy.html', target: '_blank', rel: 'noopener', text: 'Privātuma politika' }));

  if (rides.accountMode === 'delete') {
    const yes = rEl('button', { class: 'btn danger', type: 'button', text: 'Jā, dzēst neatgriezeniski', onclick: async () => {
      yes.disabled = true; say('Dzēš…', false);
      await ridesDeleteAccount(say);
      yes.disabled = false;
    } });
    wrap.append(rEl('div', { class: 'r-acc-danger' },
      rEl('b', { text: 'Dzēst kontu?' }),
      rEl('p', { text: 'Tiks dzēsts: tavs vārds, tālrunis, auto apraksts, braucienu pieprasījumi un piedāvājumi, čata ziņas, tavi ziņojumi uz ceļa un atzīmes, piekrišanu ieraksti un e-pasta / Google piesaiste. Ja esi šoferis — kartes maksājumu (Stripe) konts tiks slēgts.' }),
      rEl('p', { text: 'Paliek: ar karti veikto maksājumu ieraksti Stripe sistēmā (tos prasa grāmatvedības likumi) un anonīmie sastrēgumu mērījumi (tajos nav tava vārda vai konta). Šo darbību nevar atsaukt.' }),
      rEl('div', { class: 'r-actions' }, rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt', onclick: () => { rides.accountMode = null; rides.accountMsg = null; ridesRender(true); } }), yes)), msg);
    return wrap;
  }
  if (!a.hasSession()) {
    wrap.append(rEl('p', { class: 'r-lead', text: 'Pieslēdzies ar e-pastu — tev atsūtīs saiti, nekāda parole nav vajadzīga.' }),
      emailForm('signin', 'Sūtīt pieslēgšanās saiti'), googleBtn(false), msg,
      rEl('button', { class: 'link-btn', type: 'button', text: 'Turpināt bez konta saglabāšanas', onclick: () => { ridesSetSignedOut(false); rides.accountView = false; rides.accountMsg = null; ridesEnsureAccount(); } }));
    if (a.hasPrevious && a.hasPrevious()) wrap.append(rEl('button', { class: 'link-btn', type: 'button', text: 'Atgriezties pie iepriekšējā (šīs ierīces) konta', onclick: () => { a.restorePrevious(); ridesRefresh(true); ridesRender(true); } }));
    wrap.append(legal);
    return wrap;
  }
  if (a.isAnon) {
    if (rides.accountMode === 'conflict') {
      wrap.append(rEl('div', { class: 'r-acc-danger soft' },
        rEl('b', { text: 'Šis e-pasts jau pieder citam kontam' }),
        rEl('p', { text: 'Vari pieslēgties tam kontam. Šīs ierīces profils, braucieni un čata ziņas tiks pārcelti uz to (ja tam kontam jau ir profils — paliks tā vārds un tālrunis).' }),
        rEl('div', { class: 'r-actions' },
          rEl('button', { class: 'btn ghost', type: 'button', text: 'Atpakaļ', onclick: () => { rides.accountMode = null; ridesRender(true); } }),
          rEl('button', { class: 'btn primary', type: 'button', text: 'Pieslēgties un pārcelt', onclick: async () => {
            try { await a.signInOther(rides.accountEmail || '', czReturnUrl()); rides.accountMode = null; say(`✓ Saite nosūtīta uz ${rides.accountEmail}. Atver to šajā ierīcē.`, false); ridesRender(true); }
            catch (e) { say(czAuthErrorText(e.code, e.status)); }
          } }))), msg);
      return wrap;
    }
    if (rides.accountMode === 'other') {
      wrap.append(rEl('p', { class: 'r-lead', text: 'Pieslēdzies savam esošajam kontam. Šajā ierīcē ievadītie dati tiks pārcelti uz to.' }),
        emailForm('other', 'Sūtīt pieslēgšanās saiti'), googleBtn(true), msg,
        rEl('button', { class: 'link-btn', type: 'button', text: '← Saglabāt šo kontu ar e-pastu', onclick: () => { rides.accountMode = null; rides.accountMsg = null; ridesRender(true); } }));
    } else {
      wrap.append(rEl('p', { class: 'r-lead', text: 'Tavs konts pagaidām ir saglabāts tikai šajā ierīcē. Pievieno e-pastu — tad, nomainot telefonu vai iztīrot pārlūku, varēsi pieslēgties un nekas nepazudīs. Parole nav vajadzīga.' }),
        emailForm('link', 'Saglabāt ar e-pastu'), googleBtn(false), msg,
        rEl('button', { class: 'link-btn', type: 'button', text: 'Man jau ir konts — pieslēgties', onclick: () => { rides.accountMode = 'other'; rides.accountMsg = null; ridesRender(true); } }));
    }
  } else {
    wrap.append(rEl('p', { class: 'r-lead', text: `Pieslēdzies kā ${a.email || 'Google konts'}. Ar šo e-pastu vari pieslēgties jebkurā ierīcē.` }), msg,
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Izrakstīties', onclick: async () => {
        await a.signOut(); ridesSetSignedOut(true);
        rides.profile = null; rides.myReqs = []; rides.offers = {}; rides.myOffers = []; rides.msgs = {}; ridesHistoryReset();
        rides.accountMsg = { text: 'Tu esi izrakstījies. Lai turpinātu, pieslēdzies vēlreiz.', bad: false };
        ridesRender(true);
      } }));
  }
  if (a.hasPrevious && a.hasPrevious()) wrap.append(rEl('button', { class: 'link-btn', type: 'button', text: 'Atgriezties pie iepriekšējā (šīs ierīces) konta', onclick: () => { a.restorePrevious(); ridesRefresh(true); ridesRender(true); } }));
  wrap.append(rEl('button', { class: 'link-btn danger', type: 'button', text: 'Dzēst kontu', onclick: () => { rides.accountMode = 'delete'; rides.accountMsg = null; ridesRender(true); } }), legal);
  return wrap;
}
async function ridesDeleteAccount(say) {
  const a = rides.store.auth;
  try {
    let unclosed = null;
    const acct = await rides.store.hasDriverAccount().catch(() => null);
    if (acct) {
      try { const r = await rides.store.pay('close'); if (!r || !(r.closed || r.none)) unclosed = acct; }
      catch { unclosed = acct; }
    }
    await rides.store.deleteAccount(unclosed);
    a.forgetLocal(); ridesSetSignedOut(true);
    rides.profile = null; rides.myReqs = []; rides.offers = {}; rides.myOffers = []; rides.msgs = {}; rides.pay = {}; rides.payDrv = null; rides.payDrvOk = {}; rides.payDrvTries = {};
    ridesHistoryReset();
    rides.accountMode = null;
    rides.accountMsg = { text: '✓ Konts un tā dati ir dzēsti.' + (unclosed ? ' Kartes maksājumu (Stripe) kontu lietotnes īpašnieks slēgs manuāli.' : ''), bad: false };
    ridesRender(true);
  } catch (e) {
    console.warn('Konta dzēšana', e);
    say('Kontu neizdevās dzēst. Pārbaudi internetu un mēģini vēlreiz.');
  }
}

// ---------- F13: brauciena kopsavilkums, vērtējums, ziņošana, „Mani braucieni” ----------
// Aktīvie (pieņemtie) braucieni — ja kāds pazūd no saraksta, tas ir pabeigts vai atcelts → ielādē vēsturi.
function ridesActiveOfferIds() {
  const ids = new Set();
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) if (o.status === 'accepted') ids.add(o.id);
  for (const o of rides.myOffers) if (o.status === 'accepted') ids.add(o.id);
  return ids;
}
function ridesHistoryReset() {
  rides.history = []; rides.historyAt = 0; rides.historyErr = false; rides.historyView = false; rides.historyOpen = null;
  rides.historyFor = null; rides.rateDraft = {}; rides.reportOpen = null; rides.reportDraft = {}; rides.ratingSum = {}; rides.ratingAt = {};
  rides.statsView = false; rides.myStats = null; rides.myStatsErr = false;                                            // F16
  rides.adminView = false; rides.admin = null; rides.adminFees = null; rides.adminErr = null; rides.isAdmin = false; rides.isAdminFor = null;
}
// Vēsture: atverot „Kopā”, kad pazūd aktīvs brauciens, skatā „Mani braucieni” un citādi ik 2 min.
async function ridesHistoryLoad(force) {
  if (!rides.store || !rides.store.myHistory) return;
  if (rides.historyFor && rides.historyFor !== rides.store.id) ridesHistoryReset();     // cits konts
  if (!force && !rides.historyView && Date.now() - rides.historyAt < 120000) return;
  rides.historyAt = Date.now();
  try {
    const list = await rides.store.myHistory(50);
    // uzreiz pievienotie (ridesHistoryAddLocal), kurus serveris vēl neatdod, paliek
    const keep = rides.history.filter(h => h.local && !(list || []).some(x => x.offer_id === h.offer_id));
    rides.history = keep.concat(list || []);
    rides.historyFor = rides.store.id; rides.historyErr = false;
  } catch (e) { console.warn('Braucienu vēsture', e); rides.historyErr = true; }
}
function ridesHistoryAddLocal(h) {
  if (rides.history.some(x => x.offer_id === h.offer_id)) return;
  rides.history.unshift({ ...h, local: true });
}
// Vidējie vērtējumi: šoferi piedāvājumos, pasažieri šofera sarakstā, es pats (kešs 5 min)
async function ridesRatingsLoad(extra = []) {
  if (!rides.store || !rides.store.ratingSummary) return;
  const ids = new Set(extra);
  if (rides.store.id) ids.add(rides.store.id);
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) ids.add(o.driver_id);
  for (const o of rides.myOffers) if (o.request) ids.add(o.request.user_id);
  for (const r of rides.openList || []) ids.add(r.user_id);
  for (const h of rides.history.slice(0, 20)) if (h.other_id) ids.add(h.other_id);
  const need = [...ids].filter(id => id && Date.now() - (rides.ratingAt[id] || 0) > 300000).slice(0, 100);
  if (!need.length) return;
  for (const id of need) rides.ratingAt[id] = Date.now();
  try {
    const sum = await rides.store.ratingSummary(need);
    const next = { ...rides.ratingSum };
    for (const id of need) next[id] = sum[id] || null;
    rides.ratingSum = next;
  } catch (e) { console.warn('Vērtējumi', e); for (const id of need) rides.ratingAt[id] = 0; }
}
function ridesSummarySeen(id) {
  if (!id || rides.summarySeen.includes(id)) return;
  rides.summarySeen = rides.summarySeen.concat(id).slice(-50);
  try { localStorage.setItem('cz.rides.summarySeen', JSON.stringify(rides.summarySeen)); } catch { /* */ }
}
function ridesOpenHistory() {
  rides.historyView = true; rides.historyOpen = null; rides.reportOpen = null;
  ridesRender(true);
  ridesHistoryLoad(true).then(() => ridesRender(true));
}
// Mans vidējais vērtējums (konta skatā un vēsturē)
function ridesMyRatingRow() {
  const sum = rides.store && rides.ratingSum[rides.store.id];
  return rEl('div', { class: 'r-my-rating' },
    rEl('span', {}, rEl('small', { text: 'Tavs vērtējums' }), rEl('b', { text: sum === undefined ? '…' : rideRatingText(sum) })),
    rides.historyView ? null : rEl('button', { class: 'link-btn', type: 'button', text: 'Mani braucieni', onclick: () => { rides.accountView = false; rides.accountMsg = null; ridesOpenHistory(); } }));
}
// Zvaigžņu pogas (lielas pieskārienam). value — izvēlētais, onPick(n)
function ridesStars(value, onPick) {
  const row = rEl('div', { class: 'r-stars', role: 'group', 'aria-label': 'Vērtējums no 1 līdz 5' });
  for (let n = 1; n <= 5; n++) {
    row.append(rEl('button', { class: 'r-star' + (n <= value ? ' on' : ''), type: 'button', text: '★',
      'aria-label': n + (n === 1 ? ' zvaigzne' : ' zvaigznes') + ' no 5', 'aria-pressed': n === value ? 'true' : 'false',
      onclick: () => onPick(n) }));
  }
  return row;
}
// Kopsavilkums: h — vēstures ieraksts (piedāvājums + pieprasījums + mana loma). inHistory — atvērts no „Mani braucieni”.
function ridesSummaryCard(h, inHistory = false) {
  const id = h.offer_id, done = h.status === 'done';
  const other = { name: h.other_name || (h.offer_id ? 'Lietotājs' : ''), car: h.other_car };
  const card = rEl('div', { class: 'r-card r-summary' + (done ? ' r-ok' : '') },
    rEl('div', { class: 'r-card-top' },
      rEl('span', { class: 'r-badge', text: done ? '✓ Brauciens pabeigts' : rideHistWithdrawn(h) ? 'Pieprasījums atsaukts' : 'Brauciens atcelts' }),
      rEl('span', { class: 'r-when', text: rideDateText(h.depart_at) }),
      inHistory ? null : rEl('button', { class: 'r-x', type: 'button', 'aria-label': 'Aizvērt kopsavilkumu', text: '×',
        onclick: () => { ridesSummarySeen(id); ridesRender(true); } })),
    ridesRoute(h));
  if (h.offer_id) card.append(ridesPerson(other, '', h.role === 'driver' ? 'Pasažieris' : 'Šoferis', h.other_id));
  else card.append(rEl('p', { class: 'fine', text: 'Neviens šoferis braucienu nepieņēma.' }));
  if (h.price_cents) {
    const live = rides.pay[id];
    const pay = ridePayText(h, live);
    card.append(rEl('div', { class: 'r-pay-line' + (pay === 'Samaksāts ar karti' ? ' r-paid' : '') },
      rEl('span', { text: 'Cena ' + rideMoney(h.price_cents) }),
      rEl(pay.startsWith('↩') || pay.startsWith('Samaksāts') ? 'b' : 'small', { class: pay.startsWith('↩') ? 'r-refunded' : null, text: pay })));
  }
  if (!h.offer_id) return card;
  // Vērtējums
  if (h.my_stars) {
    card.append(rEl('div', { class: 'r-rated' },
      rEl('span', { text: 'Tavs vērtējums: ' }), rEl('b', { class: 'r-stars-text', 'aria-label': h.my_stars + ' no 5', text: rideStarsText(h.my_stars) }),
      h.my_comment ? rEl('p', { class: 'r-note', text: '“' + h.my_comment + '”' }) : null));
  } else if (done) card.append(ridesRateForm(h, inHistory));
  // Ziņot par problēmu
  if (h.reported) card.append(rEl('p', { class: 'fine r-reported', text: '✓ Ziņojums par šo braucienu nosūtīts. Paldies!' }));
  else if (rides.reportOpen === id) card.append(ridesReportForm(h));
  else card.append(rEl('button', { class: 'link-btn r-report-link', type: 'button', text: 'Ziņot par problēmu',
    onclick: () => { rides.reportOpen = id; ridesRender(true); } }));
  return card;
}
function ridesRateForm(h, inHistory) {
  const id = h.offer_id, draft = rides.rateDraft[id] || (rides.rateDraft[id] = { stars: 0, comment: '' });
  const who = h.role === 'driver' ? 'pasažieri' : 'šoferi';
  const msg = ridesCardMsg('rate:' + id);
  const comment = rEl('textarea', { class: 'r-input r-comment', id: 'rRate-' + id, maxlength: 200, rows: 2, placeholder: 'Komentārs (neobligāti)', 'aria-label': 'Komentārs (neobligāti, līdz 200 zīmēm)' });
  comment.value = draft.comment;
  comment.addEventListener('input', () => { draft.comment = comment.value; });
  const send = rEl('button', { class: 'btn primary', type: 'button', text: 'Nosūtīt vērtējumu', disabled: draft.stars ? null : true, onclick: async e => {
    if (!draft.stars) { ridesSay('rate:' + id, msg, 'Izvēlies, cik zvaigznes.'); return; }
    const b = e.currentTarget; b.disabled = true; ridesSay('rate:' + id, msg, 'Sūta…', false);
    try {
      await rides.store.rate(id, draft.stars, draft.comment);
      ridesSay('rate:' + id, msg, '');
      Object.assign(h, { my_stars: draft.stars, my_comment: draft.comment.trim() });
      delete rides.rateDraft[id]; delete rides.ratingAt[h.other_id];
      ridesToast('Paldies par vērtējumu!');
      ridesRatingsLoad([h.other_id]).then(() => ridesRender(true));
      ridesRender(true);
    } catch (err) {
      console.warn('Vērtējums', err);
      if (err.code === 'duplicate' || rideRateErr(err)) {
        ridesSay('rate:' + id, msg, 'Tu šo braucienu jau novērtēji — otrreiz vērtēt nevar.');
        ridesHistoryLoad(true).then(() => ridesRender(true));
      } else ridesSay('rate:' + id, msg, /Novērtēt var tikai/.test(err.message) ? 'Novērtēt var tikai pabeigtu braucienu.' : 'Neizdevās nosūtīt vērtējumu — pārbaudi internetu un mēģini vēlreiz.');
      b.disabled = false;
    }
  } });
  const acts = rEl('div', { class: 'r-actions' },
    inHistory ? null : rEl('button', { class: 'btn ghost', type: 'button', text: 'Izlaist', title: 'Novērtēt varēsi vēlāk sadaļā „Mani braucieni”',
      onclick: () => { ridesSummarySeen(id); ridesToast('Novērtēt varēsi vēlāk sadaļā „Mani braucieni”.'); ridesRender(true); } }),
    send);
  return rEl('div', { class: 'r-rate' },
    rEl('b', { class: 'r-rate-q', text: `Kā tev patika brauciens? Novērtē ${who}` }),
    ridesStars(draft.stars, n => { draft.stars = n; ridesSay('rate:' + id, msg, ''); ridesRender(true); }),
    comment, msg, acts);
}
function ridesReportForm(h) {
  const id = h.offer_id, draft = rides.reportDraft[id] || (rides.reportDraft[id] = { reason: '', details: '' });
  const msg = ridesCardMsg('report:' + id);
  const reasons = rEl('div', { class: 'r-reasons', role: 'radiogroup', 'aria-label': 'Iemesls' });
  for (const [k, label] of RIDE_REPORT_REASONS) {
    const inp = rEl('input', { type: 'radio', name: 'rRep-' + id, value: k });
    inp.checked = draft.reason === k;
    inp.addEventListener('change', () => { draft.reason = k; ridesSay('report:' + id, msg, ''); });
    reasons.append(rEl('label', { class: 'r-reason' }, inp, rEl('span', { text: label })));
  }
  const det = rEl('textarea', { class: 'r-input r-comment', id: 'rRepD-' + id, maxlength: 500, rows: 3, placeholder: 'Kas notika? (neobligāti, līdz 500 zīmēm)', 'aria-label': 'Apraksts' });
  det.value = draft.details;
  det.addEventListener('input', () => { draft.details = det.value; });
  const send = rEl('button', { class: 'btn danger', type: 'button', text: 'Nosūtīt ziņojumu', onclick: async e => {
    if (!draft.reason) { ridesSay('report:' + id, msg, 'Izvēlies iemeslu.'); return; }
    if (draft.reason === 'other' && !draft.details.trim()) { ridesSay('report:' + id, msg, 'Īsi apraksti, kas notika.'); det.focus(); return; }
    const b = e.currentTarget; b.disabled = true; ridesSay('report:' + id, msg, 'Sūta…', false);
    try {
      await rides.store.reportUser(id, draft.reason, draft.details);
      ridesSay('report:' + id, msg, '');
      h.reported = true; rides.reportOpen = null; delete rides.reportDraft[id];
      ridesToast('Paldies — ziņojums nosūtīts. Lietotnes komanda to izskatīs.');
      ridesRender(true);
    } catch (err) {
      console.warn('Ziņojums', err);
      ridesSay('report:' + id, msg, /Pārāk daudz/.test(err.message) ? 'Šodien nosūtīts pārāk daudz ziņojumu — mēģini rīt.' : 'Neizdevās nosūtīt ziņojumu — pārbaudi internetu un mēģini vēlreiz.');
      b.disabled = false;
    }
  } });
  return rEl('div', { class: 'r-report' },
    rEl('b', { text: 'Ziņot par problēmu' }),
    rEl('p', { class: 'fine', text: 'Ziņojumu redz tikai lietotnes komanda — otrs brauciena dalībnieks to neredzēs. Ja kāds ir apdraudēts, zvani 112.' }),
    reasons, det, msg,
    rEl('div', { class: 'r-actions' },
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt', onclick: () => { rides.reportOpen = null; ridesSay('report:' + id, msg, ''); ridesRender(true); } }),
      send));
}
// „Mani braucieni” — abas lomas, jaunākie augšā; pieskaroties — kopsavilkums, vērtējums, ziņošana
function ridesHistoryView() {
  const wrap = rEl('div', { class: 'r-history' });
  const back = () => { rides.historyView = false; rides.historyOpen = null; rides.reportOpen = null; ridesRender(true); };
  wrap.append(rEl('div', { class: 'r-acc-head' },
    rEl('button', { class: 'link-btn', type: 'button', text: '← Atpakaļ', onclick: back }),
    rEl('b', { text: 'Mani braucieni' })));
  wrap.append(ridesMyRatingRow());
  if (rides.historyErr && !rides.history.length) {
    const msg = rEl('p', { class: 'r-msg bad', role: 'alert', text: 'Braucienu vēsturi neizdevās ielādēt. Pārbaudi internetu un mēģini vēlreiz.' });
    wrap.append(msg, rEl('button', { class: 'btn ghost', type: 'button', text: 'Mēģināt vēlreiz', onclick: () => ridesOpenHistory() }));
    return wrap;
  }
  if (!rides.historyFor && !rides.history.length) { wrap.append(rEl('p', { class: 'fine', text: 'Ielādē…' })); return wrap; }
  if (!rides.history.length) { wrap.append(rEl('p', { class: 'fine r-wait', text: 'Vēl nav neviena pabeigta vai atcelta brauciena.' })); return wrap; }
  for (const h of rides.history) {
    const key = h.offer_id || h.request_id, open = rides.historyOpen === key;
    const pay = ridePayText(h, rides.pay[h.offer_id]);
    // F23: „atsaukts” — pieprasījums, kuru neviens šoferis nebija pieņēmis (nav piedāvājuma); „atcelts” — brauciens ar saskaņotu šoferi
    const meta = [h.role === 'driver' ? 'Šoferis' : 'Pasažieris', h.status === 'done' ? 'pabeigts' : rideHistWithdrawn(h) ? 'atsaukts pieprasījums' : 'atcelts brauciens',
      h.price_cents ? rideMoney(h.price_cents) + (pay ? ' · ' + pay : '') : '',
      h.status === 'done' ? (h.my_stars ? rideStarsText(h.my_stars) : 'nav novērtēts') : ''].filter(Boolean).join(' · ');
    const row = rEl('button', { class: 'r-hist-item' + (open ? ' open' : '') + (h.status === 'done' ? '' : ' cancelled'), type: 'button', 'aria-expanded': open ? 'true' : 'false',
      onclick: () => { rides.historyOpen = open ? null : key; rides.reportOpen = null; ridesRender(true); } },
      rEl('span', { class: 'r-hist-top' }, rEl('b', { text: rideDateText(h.depart_at) }), rEl('span', { class: 'r-hist-who', text: h.other_name || '' })),
      rEl('span', { class: 'r-hist-route', text: (h.from_name || 'Sākums') + ' → ' + (h.to_name || 'Galamērķis') }),
      rEl('small', { text: meta }));
    wrap.append(row);
    if (open) wrap.append(ridesSummaryCard(h, true));
  }
  return wrap;
}

// ---------- F16: „Mana statistika” un īpašnieka statistika ----------
function ridesDateLv(ymd) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; }
const RIDE_CANCELLED_NOTE = 'Braucieni, kuriem jau bija saskaņots šoferis';
const RIDE_WITHDRAWN_NOTE = 'Atsaukti vai beigušies, pirms kāds šoferis pieņēma';
function ridesStatRow(label, value, note) {
  return rEl('div', { class: 'r-stat' }, rEl('span', {}, label, note ? rEl('small', { text: note }) : null), rEl('b', { text: String(value) }));
}
function ridesStatHead(title, back) {
  return rEl('div', { class: 'r-acc-head' },
    rEl('button', { class: 'link-btn', type: 'button', text: '← Atpakaļ', onclick: back }),
    rEl('b', { text: title }));
}
async function ridesOpenStats() {
  rides.statsView = true; rides.myStats = null; rides.myStatsErr = false;
  ridesRender(true);
  try { rides.myStats = (await rides.store.myStats()) || {}; } catch (e) { console.warn('Statistika', e); rides.myStatsErr = true; }
  ridesRender(true);
}
function ridesMyStatsView() {
  const wrap = rEl('div', { class: 'r-stats' });
  wrap.append(ridesStatHead('Mana statistika', () => { rides.statsView = false; ridesRender(true); }));
  if (rides.myStatsErr) {
    wrap.append(rEl('p', { class: 'r-msg bad', role: 'alert', text: 'Statistiku neizdevās ielādēt. Pārbaudi internetu un mēģini vēlreiz.' }),
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Mēģināt vēlreiz', onclick: ridesOpenStats }));
    return wrap;
  }
  const st = rides.myStats;
  if (!st) { wrap.append(rEl('p', { class: 'fine', text: 'Ielādē…' })); return wrap; }
  const n = k => Number(st[k]) || 0;
  const rides1 = rEl('div', { class: 'r-card r-stat-card' }, rEl('b', { class: 'r-stat-t', text: '🚗 Braucieni' }));
  if (rideStatsEmpty(st)) rides1.append(rEl('p', { class: 'fine r-stat-empty', text: 'Vēl nav braucienu.' }));
  rides1.append(
    ridesStatRow('Kā šoferis — pabeigti', n('driver_done')),
    ridesStatRow('Kā šoferis — atcelti braucieni', n('driver_cancelled'), RIDE_CANCELLED_NOTE),
    ridesStatRow('Kā pasažieris — pabeigti', n('passenger_done')),
    ridesStatRow('Kā pasažieris — atcelti braucieni', n('passenger_cancelled'), RIDE_CANCELLED_NOTE),
    // F23: atsauktie pieprasījumi (neviens šoferis nebija pieņēmis) — kopā ar atceltajiem = atceltie „Mani braucieni”
    st.passenger_withdrawn == null ? null : ridesStatRow('Kā pasažieris — atsaukti pieprasījumi', n('passenger_withdrawn'), RIDE_WITHDRAWN_NOTE),
    ridesStatRow('Pārvesti pasažieri', n('carried')),
    ridesStatRow('Nobrauktais', '≈ ' + n('km_approx') + ' km', 'aptuveni: taisne no sākuma līdz galamērķim × 1,3'));
  const money = rEl('div', { class: 'r-card r-stat-card' }, rEl('b', { class: 'r-stat-t', text: '💳 Kartes maksājumi' }),
    ridesStatRow('Saņemts kā šoferim', rideMoney(n('earned_card_cents')), 'pirms lietotnes komisijas'),
    ridesStatRow('Samaksāts kā pasažierim', rideMoney(n('paid_card_cents'))),
    rEl('p', { class: 'fine', text: 'Skaidrā naudā samaksātais šeit netiek skaitīts.' }));
  const since = ridesDateLv(st.since);
  const help = rEl('div', { class: 'r-card r-stat-card' }, rEl('b', { class: 'r-stat-t', text: '🤝 Palīdzība citiem' }),
    ridesStatRow('Ceļa ziņojumi', n('reports')), ridesStatRow('Apstiprināji citu ziņojumus', n('confirms')),
    ridesStatRow('Tavus ziņojumus apstiprināja', n('confirmed')), ridesStatRow('Sastrēgumu mērījumi', n('traffic')),
    ridesStatRow('Atrasti radari', n('radars')),
    rEl('p', { class: 'fine', text: rides.store.demo ? 'Demo režīmā šie skaitļi netiek skaitīti.' : since ? `Skaitīts no ${since}.` : 'Nav datu.' }));
  const rate = rEl('div', { class: 'r-card r-stat-card' }, rEl('b', { class: 'r-stat-t', text: '★ Vērtējums' }),
    ridesStatRow('Tavs vidējais vērtējums', rideRatingText(st.rating)));
  wrap.append(rides1, money, help, rate);
  return wrap;
}
async function ridesOpenAdmin() {
  rides.adminView = true; rides.adminErr = null; rides.adminBusy = true;
  ridesRender(true);
  try {
    const [a, f] = await Promise.all([rides.store.adminStats(),
      ridesPayOn() ? rides.store.pay('admin_stats').catch(e => ({ error: e.message || 'Stripe nav pieejams' })) : Promise.resolve({ error: 'off' })]);
    rides.admin = a; rides.adminFees = f;
  } catch (e) {
    console.warn('Admin statistika', e);
    rides.adminErr = /forbidden|403/.test(String(e && e.message)) ? 'Nav piekļuves.' : 'Statistiku neizdevās ielādēt. Pārbaudi internetu un mēģini vēlreiz.';
  }
  rides.adminBusy = false;
  ridesRender(true);
}
function ridesAdminView() {
  const wrap = rEl('div', { class: 'r-stats' });
  wrap.append(ridesStatHead('Statistika', () => { rides.adminView = false; ridesRender(true); }));
  wrap.append(rEl('a', { class: 'link-btn r-stat-full', href: 'admin.html', target: '_blank', rel: 'noopener', text: 'Atvērt pilno administrēšanas lapu ↗' }));
  const refresh = rEl('button', { class: 'btn ghost r-stat-refresh', type: 'button', text: rides.adminBusy ? 'Ielādē…' : 'Atjaunot', disabled: rides.adminBusy ? true : null, onclick: ridesOpenAdmin });
  if (rides.adminErr) { wrap.append(rEl('p', { class: 'r-msg bad', role: 'alert', text: rides.adminErr }), refresh); return wrap; }
  const a = rides.admin;
  if (!a) { wrap.append(rEl('p', { class: 'fine', text: 'Ielādē…' })); return wrap; }
  const num = v => (Number(v) || 0).toLocaleString('lv-LV');
  const eur = v => rideMoney(Number(v) || 0);
  const tbl = rEl('table', { class: 'r-stat-table' });
  tbl.append(rEl('thead', {}, rEl('tr', {}, rEl('th', { text: '' }), rEl('th', { text: 'Šodien' }), rEl('th', { text: 'Šomēnes' }), rEl('th', { text: 'Kopā' }))));
  const body = rEl('tbody');
  const sec = t => body.append(rEl('tr', { class: 'r-stat-sec' }, rEl('th', { colspan: 4, text: t })));
  const row = (label, arr, fmt = num) => body.append(rEl('tr', {}, rEl('td', { text: label }),
    ...[0, 1, 2].map(i => rEl('td', { text: arr && arr[i] != null ? fmt(arr[i]) : '—' }))));
  const u = a.users || {};
  sec('Lietotāji');
  row('Jauni konti', u.new); row('Aktīvi (pieslēdzās)', u.active); row('Saglabāti konti', u.saved); row('Anonīmie', u.anon); row('Ar „Kopā” profilu', a.profiles);
  sec('Braucieni');
  row('Pieprasījumi', a.requests); row('Pabeigti', a.done);
  if (a.cancelled_rides) { row('Atcelti braucieni (ar saskaņotu šoferi)', a.cancelled_rides); row('Atsaukti pieprasījumi', a.withdrawn); }   // F23
  else row('Atcelti', a.cancelled);
  sec('Kartes maksājumi');
  row('Apmaksāti', a.paid); row('Apgrozījums', a.turnover, eur); row('Atmaksāts', a.refunds, eur);
  const f = rides.adminFees;
  if (f && f.fees) row('Komisija (Stripe)' + (f.total_partial ? ' *' : ''), [f.fees.today, f.fees.month, f.fees.total], eur);
  else {
    const pct = (f && f.fee_pct) ?? ridesFeePct();
    row(`Komisija (aptuveni, ${pct}\u00a0%)`, (a.turnover || []).map(v => Math.round((Number(v) || 0) * pct / 100)), eur);
  }
  sec('Ceļa ziņojumi');
  const types = Object.keys(a.reports || {}).sort();
  for (const t of types) row((typeof ALERT_TYPES !== 'undefined' && ALERT_TYPES[t] ? ALERT_TYPES[t].label : t), a.reports[t]);
  if (!types.length) body.append(rEl('tr', {}, rEl('td', { colspan: 4, class: 'fine', text: 'Vēl nav datu.' })));
  row('Apstiprinājumi', a.confirms);
  sec('Radari un sastrēgumi');
  row('Jauni radari', a.radars && a.radars.new); row('Sastrēgumu mērījumi', a.traffic);
  tbl.append(body);
  const active = Object.entries(a.reports_active || {}).map(([t, c]) => `${typeof ALERT_TYPES !== 'undefined' && ALERT_TYPES[t] ? ALERT_TYPES[t].label : t}: ${c}`).join(', ');
  const since = ridesDateLv(a.since);
  wrap.append(rEl('div', { class: 'r-stat-scroll' }, tbl),
    rEl('p', { class: 'fine' }, `Šobrīd aktīvi ceļa ziņojumi: ${active || 'nav'}. Nederīgi radari: ${num(a.radars && a.radars.invalid)}. Šobrīd palīdz sastrēgumu kartei: ${num(a.helpers)}.`),
    rEl('p', { class: 'fine' }, `Ceļa ziņojumi un apstiprinājumi skaitīti no ${since || '—'}; sastrēgumu mērījumiem „Kopā” — pēdējās 28 dienas. Laiks — Rīgas.` +
      (f && f.fees ? (f.total_partial ? ' * Komisija „Kopā” — pēdējās 2000 maksas.' : '') : ' Komisija aprēķināta no apgrozījuma (Stripe dati nav pieejami).')),
    refresh);
  return wrap;
}

// Drošībai: ja app-gl.js to vēl nav izsaucis (ielādes secība), palaiž, kad lapa ielādēta.
window.addEventListener('load', () => { if (!rides.store && document.getElementById('ridesBtn')) ridesInit(); });
