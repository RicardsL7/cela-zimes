// ---------- Kopbraucieni: saskarne ----------
// Poga "Kopā" → logs ar divām cilnēm: "Man vajag aizbraukt" (pasažieris) un "Es braucu" (šoferis).
// Izmanto app-gl.js kopīgās lietas: $, state, map, store, searchPhoton, selectDestination, setStatus.

const rides = {
  store: null, ready: false, tab: 'need', open: false,
  profile: null, myReqs: [], offers: {}, myOffers: [], openList: [],
  timer: null, markers: [], seen: null, from: null, to: null,
  msgs: {}, seenMsg: {}, chat: null, unreadTotal: 0,             // čats
  pay: {}, payCfg: null, payDrv: null, payAt: 0, payDrvBusy: false,      // kartes maksājumi
  live: { timer: null, lastDrv: null, lastPas: 0, route: null, routeKey: '', routeAt: 0, carMarker: null, pasMarker: null, destMarker: null },
};
try { rides.seenMsg = JSON.parse(localStorage.getItem('cz.rides.seenMsg') || '{}'); } catch { rides.seenMsg = {}; }

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
  try { await rides.store.init(); rides.ready = true; }
  catch (err) { console.warn('Kopbraucieni nav pieejami', err); rides.ready = false; }
  $('ridesBtn').addEventListener('click', () => ridesOpen(true));
  $('closeRides').addEventListener('click', () => ridesOpen(false));
  $('tabNeed').addEventListener('click', () => ridesTab('need'));
  $('tabDrive').addEventListener('click', () => ridesTab('drive'));
  $('ridesDemoAdd').addEventListener('click', ridesAddDemo);
  for (const id of ['settingsBtn', 'reportBtn', 'placesBtn']) { const b = $(id); if (b) b.addEventListener('click', () => { if (rides.open) ridesOpen(false); }); }
  $('ridesDemo').hidden = !rides.store.demo;
  rides.tab = store.get('ridesTab', 'need');
  if (rides.ready) { await ridesRefresh(true); ridesSchedule(); ridesPayReturn(); }
}
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
    ridesRefresh(false);
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
  try {
    // Ik 5 min sakārto novecojušos braucienus (neapstiprināti, nesākti vai "aizmirsti" ceļā)
    if (rides.store.expire && Date.now() - (rides.expireAt || 0) > 5 * 60000) {
      rides.expireAt = Date.now();
      try { await rides.store.expire(); } catch (e) { console.warn('Braucienu tīrīšana', e); }
    }
    rides.profile = await rides.store.profile();
    rides.myReqs = await rides.store.myRequests();
    rides.offers = {};
    for (const r of rides.myReqs) rides.offers[r.id] = await rides.store.offersFor(r.id);
    rides.myOffers = await rides.store.myOffers();
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
  else if (fresh.some(s => s.startsWith('m:') && s.endsWith(':declined'))) msg = 'Pasažieris izvēlējās citu šoferi.';
  else if (fresh.some(s => s.startsWith('o:') && s.endsWith(':pending'))) msg = 'Kāds šoferis piedāvā tevi aizvest!';
  else if (moreUnread && lastMsg) msg = `Ziņa no ${lastMsg.name}: ${lastMsg.body.slice(0, 60)}`;
  if (!msg) return;
  setStatus(msg);
  if (!rides.open) $('ridesBtn').classList.add('has-news');
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
    rides.pay, rides.payCfg, rides.payDrv]);
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
    try { await rides.store.createRequest(req); rides.extraForm = false; await ridesRefresh(true); ridesRender(true); setStatus('Pieprasījums publicēts — šoferi to redz.'); }
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
function ridesPerson(p, phone, extra) {
  return rEl('div', { class: 'r-person' },
    rEl('span', { class: 'r-avatar', text: ((p && p.name) || '?').trim().charAt(0).toUpperCase() }),
    rEl('div', { class: 'r-pinfo' }, rEl('strong', { text: (p && p.name) || 'Lietotājs' }),
      rEl('small', { text: [p && p.car, extra].filter(Boolean).join(' · ') })),
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
    card.append(ridesPerson(accepted.driver, accepted.phone, ''));
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
        ridesPerson(o.driver, '', [o.eta_min != null ? `var paņemt pēc ~${o.eta_min} min` : '', o.price_cents ? 'cena ' + rideMoney(o.price_cents) : 'bez maksas / vienosieties'].filter(Boolean).join(' · ')),
        o.note ? rEl('p', { class: 'r-note', text: '“' + o.note + '”' }) : null,
        rEl('div', { class: 'r-actions' },
          ridesChatBtn(o.id, (o.driver && o.driver.name) || 'Šoferis'),
          rEl('button', { class: 'btn ghost', type: 'button', text: 'Noraidīt', onclick: async () => { await rides.store.respond(o.id, 'declined'); ridesRefresh(true); } }),
          rEl('button', { class: 'btn primary', type: 'button', text: 'Pieņemt', onclick: async () => { await rides.store.respond(o.id, 'accepted'); ridesRefresh(true); setStatus('Brauciens saskaņots!'); } }))));
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
    rEl('button', { class: 'btn danger small', type: 'button', text: 'Jā, atcelt', onclick: async () => { await rides.store.setRequestStatus(r.id, 'cancelled'); ridesRefresh(true); } }));
  (card || $('ridesBody')).append(box);
}

function ridesDriveView() {
  const wrap = rEl('div');
  if (rides.profile && !rides.profile.car) wrap.append(ridesCarPrompt());
  const payCard = ridesPayDriverCard();
  if (payCard) wrap.append(payCard);
  const mine = rides.myOffers.filter(o => o.status === 'accepted' || o.status === 'pending');
  if (mine.length) {
    wrap.append(rEl('h3', { class: 'r-h3', text: 'Tavi piedāvājumi' }));
    for (const o of mine) wrap.append(ridesMyOfferCard(o));
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
    ridesPerson(r.passenger, '', meta),
    ridesRoute(r),
    r.note ? rEl('p', { class: 'r-note', text: '“' + r.note + '”' }) : null,
    rEl('label', { class: 'r-price-row' },
      rEl('span', { text: `Ceļa izmaksu daļa (neobligāti, līdz ${rideMoney(cap)})` }),
      rEl('span', { class: 'r-price-box' }, price, rEl('b', { text: '€' }))),
    rEl('div', { class: 'r-actions' },
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Kartē', onclick: () => { map.easeTo({ center: [r.from_lng, r.from_lat], zoom: 15 }); } }),
      rEl('button', { class: 'btn primary', type: 'button', text: 'Paņemšu', onclick: async e => {
        const say = (text, bad = true) => { msg.textContent = text; msg.className = 'r-msg' + (bad ? ' bad' : ''); msg.hidden = false; setStatus(text); };
        const cents = rideParsePrice(price.value);
        if (Number.isNaN(cents)) { say('Cenu ieraksti skaitļos, piem. 4,50'); price.focus(); return; }
        if (cents != null && cents > cap) { say(`Cena var būt līdz ${rideMoney(cap)} — tās ir aptuvenās ceļa izmaksas.`); price.focus(); return; }
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
            : /pārsniedz/.test(t) ? `Cena pārsniedz ceļa izmaksas (maks. ${rideMoney(cap)}).`
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
    ridesPerson(o.passenger, ok ? o.phone : '', ''),
    ridesRoute(r));
  if (ok) card.append(rEl('p', { class: 'r-trip', id: 'trip-' + o.id, text: rideDriverStatus(o, state.me) }));
  if (o.price_cents) card.append(ridesDriverPayLine(o, ok));
  const acts = rEl('div', { class: 'r-actions' });
  if (st !== 'onboard') acts.append(rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt', onclick: async () => { await rides.store.cancelOffer(o.id); ridesRefresh(true); } }));
  acts.append(ridesChatBtn(o.id, (o.passenger && o.passenger.name) || 'Pasažieris'));
  const step = (text, fn) => acts.append(rEl('button', { class: 'btn primary', type: 'button', text, onclick: async e => {
    e.target.disabled = true;
    try { await fn(); } catch (err) { console.warn(err); setStatus('Neizdevās — pārbaudi internetu un mēģini vēlreiz.'); }
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
      setStatus('Brauciens pabeigts. Paldies!');
    });
  }
  card.append(acts);
  return card;
}
// ---------- Kartes maksājumi (Stripe caur servera funkciju ride-pay) ----------
function ridesPayOn() { return !!(rides.store && rides.store.pay) && !(rides.payCfg && rides.payCfg.off); }
function ridesPayIds() {
  const ids = [];
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) if (o.status === 'accepted' && o.price_cents) ids.push(o.id);
  for (const o of rides.myOffers) if (o.status === 'accepted' && o.price_cents) ids.push(o.id);
  return ids;
}
async function ridesPayRefresh(force) {
  if (!ridesPayOn()) return;
  const ids = ridesPayIds();
  if (!ids.length || (!force && Date.now() - rides.payAt < 20000)) return;
  rides.payAt = Date.now();
  try {
    const j = await rides.store.pay('status', { offer_ids: ids });
    rides.pay = j.pay || {}; rides.payCfg = { test: !!j.test, fee_pct: j.fee_pct ?? RIDE_FEE_PCT };
  } catch (e) { if (e.status === 503) rides.payCfg = { off: true }; else console.warn('Maksājumi', e); }
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
  if (email) email.addEventListener('input', () => { rides.payEmail = email.value; });
  const go = async e => {
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.value.trim())) { setStatus('Ieraksti savu e-pastu.'); email.focus(); return; }
    e.target.disabled = true;
    try { const j = await rides.store.pay('connect', { return_url: ridesReturnUrl(), email: email ? email.value.trim() : '' }); location.href = j.url; }
    catch (err) { setStatus(err.message || 'Neizdevās atvērt pieslēgšanu.'); e.target.disabled = false; }
  };
  const box = rEl('div', { class: 'r-pay-card' + (d.ready ? ' r-pay-ready' : '') },
    rEl('div', { class: 'r-pay-head' }, rEl('b', { text: '💳 Kartes maksājumi' }), rides.payCfg && rides.payCfg.test ? rEl('span', { class: 'r-pay-badge', text: 'TESTS' }) : null));
  if (d.ready) box.append(rEl('p', { class: 'r-pay-txt', text: `Pasažieri var tev samaksāt ar karti. Tu saņem cenu mīnus ${pct} % lietotnes komisija — nauda nonāk tavā bankas kontā caur Stripe.` }));
  else {
    box.append(rEl('p', { class: 'r-pay-txt', text: d.connected
      ? 'Pieslēgšana nav pabeigta — Stripe vēl vajag dažus datus.'
      : `Lai pasažieri var samaksāt ar karti tieši lietotnē, pieslēdz maksājumu saņemšanu. Datus un bankas kontu pārbauda Stripe; tu saņem cenu mīnus ${pct} % komisija.` }));
    if (email) box.append(rEl('label', { class: 'r-label', for: 'rpPayEmail', text: 'Tavs e-pasts (uz to Stripe sūtīs paziņojumus par izmaksām)' }), email);
    box.append(rEl('button', { class: 'btn primary', type: 'button', text: d.connected ? 'Turpināt pieslēgšanu' : 'Pieslēgt maksājumus', onclick: go }));
  }
  return box;
}
// Šoferim: cena un vai samaksāts
function ridesDriverPayLine(o, ok) {
  const { driver } = rideSplit(o.price_cents, ridesFeePct());
  const p = rides.pay[o.id];
  const text = `Cena ${rideMoney(o.price_cents)}` + (ridesPayOn() ? ` · ar karti tu saņem ${rideMoney(driver)}` : '');
  return rEl('div', { class: 'r-pay-line' + (p && p.paid ? ' r-paid' : '') },
    rEl('span', { text }),
    ok && p && p.paid ? rEl('b', { text: '✓ Samaksāts ar karti' }) : ok ? rEl('small', { text: 'Vēl nav samaksāts (var arī skaidrā)' }) : null);
}
// Pasažierim: maksāt ar karti
function ridesPassengerPay(o) {
  if (!o.price_cents) return null;
  const p = rides.pay[o.id];
  const box = rEl('div', { class: 'r-pay-line' + (p && p.paid ? ' r-paid' : '') }, rEl('span', { text: 'Cena ' + rideMoney(o.price_cents) }));
  if (p && p.paid) { box.append(rEl('b', { text: '✓ Samaksāts ar karti' })); return box; }
  if (!ridesPayOn()) { box.append(rEl('small', { text: 'Samaksā šoferim, kā vienojāties.' })); return box; }
  const btn = rEl('button', { class: 'btn primary r-pay-btn', type: 'button', text: 'Maksāt ar karti', onclick: async e => {
    e.target.disabled = true; e.target.textContent = 'Atveru…';
    try { const j = await rides.store.pay('checkout', { offer_id: o.id, return_url: ridesReturnUrl() }); location.href = j.url; }
    catch (err) { setStatus(err.message || 'Neizdevās atvērt maksājumu.'); e.target.disabled = false; e.target.textContent = 'Maksāt ar karti'; }
  } });
  const wrap = rEl('div', { class: 'r-pay-wrap' }, box, btn);
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
  if (msg) setStatus(msg);
  if (v === 'connected' || v === 'connect-retry') { rides.payDrv = null; if (rides.tab !== 'drive') ridesTab('drive'); }
  ridesOpen(true);
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

// Drošībai: ja app-gl.js to vēl nav izsaucis (ielādes secība), palaiž, kad lapa ielādēta.
window.addEventListener('load', () => { if (!rides.store && document.getElementById('ridesBtn')) ridesInit(); });
