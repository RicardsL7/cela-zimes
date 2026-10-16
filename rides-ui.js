// ---------- Kopbraucieni: saskarne ----------
// Poga "Kopā" → logs ar divām cilnēm: "Man vajag aizbraukt" (pasažieris) un "Es braucu" (šoferis).
// Izmanto app-gl.js kopīgās lietas: $, state, map, store, searchPhoton, selectDestination, setStatus.

const rides = {
  store: null, ready: false, tab: 'need', open: false,
  profile: null, myReqs: [], offers: {}, myOffers: [], openList: [],
  timer: null, markers: [], seen: null, from: null, to: null,
};

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
  if (rides.ready) { await ridesRefresh(true); ridesSchedule(); }
}
function ridesSchedule() {
  clearInterval(rides.timer);
  rides.timer = setInterval(() => {
    const active = rides.myReqs.length || rides.myOffers.some(o => o.status !== 'declined');
    if (rides.open || active) ridesRefresh(false);
  }, 15000);
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
    rides.profile = await rides.store.profile();
    rides.myReqs = await rides.store.myRequests();
    rides.offers = {};
    for (const r of rides.myReqs) rides.offers[r.id] = await rides.store.offersFor(r.id);
    rides.myOffers = await rides.store.myOffers();
    if (rides.open && rides.tab === 'drive') rides.openList = await rides.store.openRequests(ridesBox());
  } catch (err) { console.warn('Kopbraucieni: neizdevās atjaunot', err); }
  ridesNotify(first);
  ridesRender();
}
// Paziņojumi: jauns piedāvājums manam pieprasījumam / mans piedāvājums pieņemts.
function ridesNotify(first) {
  const sig = new Set();
  for (const r of rides.myReqs) for (const o of rides.offers[r.id] || []) sig.add('o:' + o.id + ':' + o.status);
  for (const o of rides.myOffers) sig.add('m:' + o.id + ':' + o.status);
  const prev = rides.seen; rides.seen = sig;
  if (first || !prev) return;
  const fresh = [...sig].filter(s => !prev.has(s));
  if (!fresh.length) return;
  let msg = null;
  if (fresh.some(s => s.startsWith('m:') && s.endsWith(':accepted'))) msg = 'Pasažieris pieņēma tavu piedāvājumu!';
  else if (fresh.some(s => s.startsWith('m:') && s.endsWith(':declined'))) msg = 'Pasažieris izvēlējās citu šoferi.';
  else if (fresh.some(s => s.startsWith('o:') && s.endsWith(':pending'))) msg = 'Kāds šoferis piedāvā tevi aizvest!';
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
    rides.myReqs.map(r => r.id + r.status + (rides.offers[r.id] || []).map(o => o.id + o.status + o.phone).join()),
    rides.myOffers.map(o => o.id + o.status + o.phone + (o.request && o.request.status)),
    rides.tab === 'drive' ? rides.openList.map(r => r.id + r.status) : null]);
}
function ridesRender(force = false) {
  if (!rides.open) return;
  const body = $('ridesBody');
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
  body.append(rides.tab === 'need' ? ridesNeedView() : ridesDriveView());
  if (rides.tab !== 'drive') ridesMarkers([]);
}

function ridesProfileForm(editing = false) {
  const p = rides.profile || {};
  const name = rEl('input', { class: 'r-input', id: 'rpName', maxlength: 40, autocomplete: 'given-name', placeholder: 'Piem. Ilze' }); name.value = p.name || '';
  const phone = rEl('input', { class: 'r-input', id: 'rpPhone', type: 'tel', maxlength: 20, autocomplete: 'tel', placeholder: '+371 2…' }); phone.value = p.phone || '';
  const car = rEl('input', { class: 'r-input', id: 'rpCar', maxlength: 60, placeholder: 'Piem. pelēks Škoda Octavia (ja vadīsi)' }); car.value = p.car || '';
  const err = rEl('p', { class: 'r-err', hidden: true });
  const save = async () => {
    const v = { name: name.value, phone: phone.value, car: car.value };
    const e = rideProfileValid(v);
    if (e) { err.textContent = e; err.hidden = false; return; }
    try { await rides.store.saveProfile(v); await ridesRefresh(true); ridesRender(true); }
    catch (x) { err.textContent = 'Neizdevās saglabāt. Pamēģini vēlreiz.'; err.hidden = false; console.warn(x); }
  };
  return rEl('div', { class: 'r-form' },
    rEl('p', { class: 'r-lead', text: editing ? 'Tavs profils' : 'Vispirms pastāsti, kā tevi sauc — to redzēs otrs brauciena dalībnieks.' }),
    rEl('label', { class: 'r-label', for: 'rpName', text: 'Vārds' }), name,
    rEl('label', { class: 'r-label', for: 'rpPhone', text: 'Tālrunis (redzams tikai tam, ar kuru vienosieties)' }), phone,
    rEl('label', { class: 'r-label', for: 'rpCar', text: 'Auto (tikai šoferiem, neobligāti)' }), car,
    err,
    rEl('button', { class: 'btn primary r-wide', type: 'button', onclick: save, text: 'Saglabāt' }));
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
    card.append(ridesPerson(accepted.driver, accepted.phone, accepted.eta_min != null ? `būs pēc ~${accepted.eta_min} min` : ''));
    card.append(rEl('p', { class: 'fine', text: 'Sazinieties pa tālruni. Pirms iekāpšanas pārliecinies, ka auto atbilst aprakstam.' }));
    card.append(rEl('div', { class: 'r-actions' },
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt braucienu', onclick: () => ridesConfirmCancel(r) }),
      rEl('button', { class: 'btn primary', type: 'button', text: 'Gatavs', onclick: async () => { await rides.store.setRequestStatus(r.id, 'done'); ridesRefresh(true); } })));
  } else {
    if (!pending.length) card.append(rEl('p', { class: 'fine r-wait', text: 'Pieprasījumu redz šoferi, kuri brauc tajā pusē. Kad kāds piedāvās, tas parādīsies šeit.' }));
    for (const o of pending) {
      card.append(rEl('div', { class: 'r-offer' },
        ridesPerson(o.driver, '', o.eta_min != null ? `var paņemt pēc ~${o.eta_min} min` : ''),
        o.note ? rEl('p', { class: 'r-note', text: '“' + o.note + '”' }) : null,
        rEl('div', { class: 'r-actions' },
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
  const meta = [rideTimeText(r.depart_at), r.seats + ' cilv.',
    x.match ? `+${x.match.detourMin} min apkārtceļš` : x.dist != null ? rideDistText(x.dist) + ' no tevis' : ''].filter(Boolean).join(' · ');
  return rEl('div', { class: 'r-card' },
    ridesPerson(r.passenger, '', meta),
    ridesRoute(r),
    r.note ? rEl('p', { class: 'r-note', text: '“' + r.note + '”' }) : null,
    rEl('div', { class: 'r-actions' },
      rEl('button', { class: 'btn ghost', type: 'button', text: 'Kartē', onclick: () => { map.easeTo({ center: [r.from_lng, r.from_lat], zoom: 15 }); } }),
      rEl('button', { class: 'btn primary', type: 'button', text: 'Paņemšu', onclick: async e => {
        e.target.disabled = true;
        try { await rides.store.offer(r.id, { eta_min: ridesEtaMin(r) }); setStatus('Piedāvājums nosūtīts — gaidi pasažiera atbildi.'); }
        catch (err) { console.warn(err); setStatus('Neizdevās nosūtīt piedāvājumu.'); }
        ridesRefresh(true);
      } })));
}
function ridesMyOfferCard(o) {
  const r = o.request, ok = o.status === 'accepted';
  const card = rEl('div', { class: 'r-card' + (ok ? ' r-ok' : '') },
    rEl('div', { class: 'r-card-top' },
      rEl('span', { class: 'r-badge', text: ok ? 'Pasažieris gaida tevi' : 'Gaida pasažiera atbildi' }),
      rEl('span', { class: 'r-when', text: rideTimeText(r.depart_at) })),
    ridesPerson(o.passenger, ok ? o.phone : '', ''),
    ridesRoute(r));
  const acts = rEl('div', { class: 'r-actions' },
    rEl('button', { class: 'btn ghost', type: 'button', text: 'Atcelt', onclick: async () => { await rides.store.cancelOffer(o.id); ridesRefresh(true); } }));
  if (ok) acts.append(rEl('button', { class: 'btn primary', type: 'button', text: 'Braukt pakaļ', onclick: () => {
    ridesOpen(false);
    selectDestination({ name: 'Pasažieris: ' + ((o.passenger && o.passenger.name) || ''), sub: r.from_name, lat: r.from_lat, lng: r.from_lng });
  } }));
  card.append(acts);
  return card;
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
