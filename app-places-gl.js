// Ceļa Zīmes — vietas tuvumā un vietas darbības (Zvanīt · Mājaslapa · Lietotne).
// B16 (audits 2): pārcelts no app-gl.js bez izmaiņām (tas pats globālais tvērums — klasisks skripts, ne modulis).
// Ielādējas PĒC app-gl.js un PIRMS app-start.js (kas izsauc init()): augšējā līmeņa kods šeit drīkst izmantot visu no
// app-gl.js; app-gl.js augšējā līmenī (ārpus funkcijām) šī faila nosaukumus izmantot nedrīkst. Pārbaude: tools/check-js.mjs.

// ---------- Vietas tuvumā (degviela, ēdiens, viesnīcas…) ----------
let placeMarkers = [], placeSeq = 0;
function clearPlaceMarkers() { for (const m of placeMarkers) m.remove(); placeMarkers = []; }
function openPlaces() {
  toggleSettings(false);
  tilePoiSnapshot = readTilePois();
  $('results').hidden = true;
  showPlaceCats();
  $('placesSheet').hidden = false;
}
// Kamēr saraksts atvērts, statusi ("aizveras pēc 12 min") atjaunojas katru minūti
setInterval(() => {
  if ($('placesSheet').hidden || $('placeResults').hidden || !lastPlacesRender) return;
  const { places, catId, c } = lastPlacesRender;
  renderPlaces(places, catId, c, false);
}, 60000);
function closePlaces() {
  $('placesSheet').hidden = true;
  placeSeq++;
  clearPlaceMarkers();
}
function showPlaceCats() {
  placeSeq++;
  clearPlaceMarkers();
  $('placesTitle').textContent = 'Kategorijas';
  $('placesBack').hidden = true;
  $('placeResults').hidden = true;
  $('placeCats').hidden = false;
}
function placeSub(p, st) {
  const bits = [navDist(p.d)];
  if (st && st.text) bits.push(st.text);
  if (p.addr) bits.push(p.addr);
  bits.push(...p.extra);
  return bits.join(' · ');
}
// Ātri:
//  1) telefona kešatmiņa (tā pati kategorija ~1 km rādiusā, ≤ 24 h) — uzreiz;
//  2) vietas, kas jau ir ielādētajā kartē (flīžu POI) — uzreiz, bez interneta;
//  3) tīkls: Photon; ja tas 2,5 s neatbild — paralēli arī Overpass; ņem pirmo atbildi;
//  4) fonā darba laiki pēc OSM id. Visi pieprasījumi ar laika limitu.
const PLACES_MAX_AGE = 24 * 3600 * 1000;
function placesKey(catId, c) { return 'c2:' + catId + ':' + Math.round(c.lat / 0.01) + ':' + Math.round(c.lng / 0.01); }
function freshPlaces(list, c) {        // attālumi no tagadējās vietas, "atvērts" pēc tagadējā laika
  const now = new Date();
  return resortPlaces(list, c.lat, c.lng).map(p => Object.assign(p, { open: placeOpenNow(p.oh, now, parseCondition) },
    // F24: kešatmiņā (≤ 24 h) var būt saraksts no vecākas versijas — apraksta nosaukumu („EV charging type 2”) rāda kā kategoriju
    isGenericName(p.name, p.cat) ? { name: placeLabelOne(p.cat) } : {}));
}
async function fetchPhotonPlaces(catId, c) {
  let places = [];
  for (const km of [5, 25]) {                      // ja tuvumā maz — meklē tālāk
    const j = await fetchJson(buildPhotonPlacesUrl(catId, c.lat, c.lng, km, 25), {}, 8000);
    places = parsePhotonPlaces(j.features, catId, c.lat, c.lng);
    if (places.length >= 5) break;
  }
  return places;
}
async function fetchOverpassPlaces(catId, c) {
  let places = [];
  for (const r of [3000, 15000]) {
    const data = await fetchOverpass(buildPlacesQuery(catId, c.lat, c.lng, r), 20000);
    places = parsePlaces(data.elements, catId, c.lat, c.lng, new Date(), parseCondition);
    if (places.length >= 5) break;
  }
  return places;
}
// Kartes POI nolasa brīdī, kad atver "Atrast tuvumā" (tad karte rāda lietotāja apkārtni);
// vēlāk karte var būt attālināta citas kategorijas rezultātiem, tāpēc izmanto šo momentuzņēmumu.
let tilePoiSnapshot = null;
function readTilePois() {
  try {
    const st = map.getStyle();
    const src = st && Object.keys(st.sources).find(k => st.sources[k].type === 'vector');
    return src ? map.querySourceFeatures(src, { sourceLayer: 'poi' }).map(f => ({ properties: f.properties, geometry: f.geometry })) : [];
  } catch { return []; }
}
// Darba laiki pēc OSM id no OpenStreetMap API (~0,3 s, daudz stabilāk par Overpass);
// ja tas neatbild — Overpass. Atgriež elementus { type, id, tags }.
async function fetchPlaceDetails(places) {
  const ids = { node: [], way: [], relation: [] };
  for (const p of places) if (p.osmType && p.osmId) ids[p.osmType].push(p.osmId);
  try {
    const parts = await Promise.all(Object.entries(ids).filter(([, v]) => v.length).map(([t, v]) =>
      fetchJson(`https://api.openstreetmap.org/api/0.6/${t}s.json?${t}s=${v.join(',')}`, {}, 8000)));
    return parts.flatMap(j => j.elements || []);
  } catch {
    const q = buildPlaceDetailsQuery(places);
    if (!q) return [];
    return (await fetchOverpass(q, 20000)).elements || [];
  }
}
async function enrichPlaces(places, key, catId, c, seq) {
  if (!places.some(p => p.osmType && !p.det)) return;
  try {
    const els = await fetchPlaceDetails(places);
    const merged = mergePlaceDetails(places, els, new Date(), parseCondition).map(p => Object.assign(p, { det: true }));
    cachePut('places', key, merged);
    if (seq !== placeSeq) return;
    $('placeStatus').textContent = placesStatusText(merged, c);
    renderPlaces(merged, catId, c, false);
  } catch { /* bez darba laikiem saraksts paliek kā ir */ }
}
function tilePlaces(catId, c) {
  if (!tilePoiSnapshot || !tilePoiSnapshot.length) tilePoiSnapshot = readTilePois();
  return parseTilePlaces(tilePoiSnapshot, catId, c.lat, c.lng);
}
function placesStatusText(places, c) {
  return places.length
    ? (state.me ? 'Tuvākās no tavas atrašanās vietas' : 'Tuvākās no kartes centra') + ' · dati: OpenStreetMap'
    : 'Tuvumā nekas netika atrasts.';
}
// ---------- Vietas darbības: Zvanīt · Mājaslapa · Lietotne ----------
const PLATFORM = /android/i.test(navigator.userAgent) ? 'android'
  : (/iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) ? 'ios' : 'desktop';
const PA_ICON = {
  call: '<path d="M6.6 3.5 9 3l1.6 4.2-2 1.5a11 11 0 0 0 6.7 6.7l1.5-2L21 15l-.5 2.4a2 2 0 0 1-2 1.6A15.5 15.5 0 0 1 5 5.5a2 2 0 0 1 1.6-2Z" fill="currentColor"/>',
  web: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.6 12h16.8M12 3.4c2.6 2.4 3.6 5.4 3.6 8.6s-1 6.2-3.6 8.6c-2.6-2.4-3.6-5.4-3.6-8.6s1-6.2 3.6-8.6Z" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  app: '<rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.4v6.4m-2.8-2.8L12 13.8l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.4 18h3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
};
function paLink(kind, href, text, title, ext) {
  const a = document.createElement('a');
  a.className = 'pa pa-' + kind; a.href = href; a.title = title;
  if (ext) { a.target = '_blank'; a.rel = 'noopener noreferrer external'; a.referrerPolicy = 'no-referrer'; }
  a.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' + PA_ICON[kind] + '</svg><span></span>';
  a.querySelector('span').textContent = text;
  a.addEventListener('click', ev => ev.stopPropagation());
  return a;
}
// Atgriež pogu rindu vai null. Saites veidotas tikai no places.js pārbaudītām vērtībām (tel:+cipari, https://domēns).
function placeActionsEl(ct) {
  if (!ct) return null;
  const row = document.createElement('div');
  row.className = 'place-acts';
  if (ct.phone && /^tel:\+?\d{7,15}$/.test(ct.phone.tel)) row.append(paLink('call', ct.phone.tel, 'Zvanīt', 'Zvanīt ' + ct.phone.label, false));
  if (ct.web && /^https:\/\//.test(ct.web.url)) row.append(paLink('web', ct.web.url, ct.web.host, (ct.brandWeb ? 'Tīkla oficiālā mājaslapa: ' : 'Mājaslapa: ') + ct.web.host, true));
  const store = ct.app && ct.app[PLATFORM];
  if (store && /^https:\/\/(play\.google\.com|apps\.apple\.com)\//.test(store)) row.append(paLink('app', store, ct.app.name + ' lietotne', (PLATFORM === 'ios' ? 'App Store' : 'Google Play') + ': oficiālā ' + ct.app.name + ' lietotne', true));
  return row.childNodes.length ? row : null;
}
const PLACE_DOT_TITLE = { open: 'Atvērts', closing: 'Drīz aizvērsies', opening: 'Drīz atvērsies', closed: 'Slēgts', unknown: 'Darba laiks nav zināms' };
let lastPlacesRender = null;
function renderPlaces(places, catId, c, fit) {
  lastPlacesRender = { places, catId, c };
  const ul = $('placeList');
  ul.textContent = '';
  clearPlaceMarkers();
  const now = new Date();
  for (const p of places) {
    const st = placeStatus(p.oh, now, parseCondition);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'place-item';
    b.innerHTML = placeIconSvg(catId, 34) + '<span class="pl-text"><span class="pl-name"><span class="pl-dot"></span><strong></strong></span><span class="pl-sub"></span></span><span class="pl-go">Braukt</span>';
    const dot = b.querySelector('.pl-dot');
    dot.classList.add('st-' + st.state); dot.title = PLACE_DOT_TITLE[st.state];
    b.querySelector('strong').textContent = p.name;
    b.querySelector('.pl-sub').innerHTML = '';
    const sub = b.querySelector('.pl-sub');
    const bits = placeSub(p, null);
    if (st.text) { const em = document.createElement('span'); em.className = 'pl-st st-' + st.state; em.textContent = st.text; sub.append(navDist(p.d) + ' · ', em); const rest = bits.slice(navDist(p.d).length); if (rest) sub.append(rest); }
    else sub.textContent = bits;
    b.addEventListener('click', () => goToPlace(p));
    li.appendChild(b);
    const acts = placeActionsEl(p.ct);
    if (acts) { li.classList.add('has-acts'); li.appendChild(acts); }
    ul.appendChild(li);
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'place-marker'; el.title = p.name + (st.text ? ' — ' + st.text : '');
    el.innerHTML = placeIconSvg(catId, 30) + '<span class="pm-dot st-' + st.state + '"></span>';
    el.addEventListener('click', ev => { ev.stopPropagation(); goToPlace(p); });
    placeMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
  }
  if (fit && places.length) {
    state.follow = false;
    const pts = places.slice(0, 8).map(p => [p.lng, p.lat]).concat([[c.lng, c.lat]]);
    const lngs = pts.map(q => q[0]), lats = pts.map(q => q[1]);
    const sheetH = $('placesSheet').offsetHeight;
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top: 90, bottom: Math.min(sheetH + 30, map.getContainer().clientHeight - 200), left: 40, right: 90 }, maxZoom: 16, pitch: 0, bearing: 0, duration: 800 });
  }
}
async function showPlaces(catId) {
  const cat = PLACE_CATEGORIES.find(c => c.id === catId);
  const seq = ++placeSeq;
  clearPlaceMarkers();
  $('placesTitle').textContent = cat.label;
  $('placesBack').hidden = false;
  $('call112').hidden = catId !== 'crisis';                 // v133: emergency → big 112 button on top
  $('placeCats').hidden = true;
  $('placeResults').hidden = false;
  $('placeList').textContent = '';
  const c = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  const key = placesKey(catId, c);

  // 1) Kešatmiņa
  const hit = await cacheGet('places', key, PLACES_MAX_AGE);
  if (seq !== placeSeq) return;
  if (hit) {
    const list = freshPlaces(hit, c).slice(0, 25);
    $('placeStatus').textContent = placesStatusText(list, c);
    renderPlaces(list, catId, c, true);
    return enrichPlaces(hit, key, catId, c, seq);     // ja saglabātajam sarakstam vēl nav darba laiku
  }

  // 2) Uzreiz no kartes
  const tile = tilePlaces(catId, c).slice(0, 25);
  if (tile.length) {
    $('placeStatus').textContent = 'Tuvākās kartē · meklē vēl…';
    renderPlaces(tile, catId, c, true);
  } else $('placeStatus').textContent = 'Meklē tuvumā…';

  // 3) Tīkls: Photon, pēc 2,5 s paralēli arī Overpass
  let settled = false;
  const photon = fetchPhotonPlaces(catId, c).then(p => ({ p, viaPhoton: true }));
  const overpass = new Promise((res, rej) => setTimeout(() => {
    if (settled || seq !== placeSeq) return rej(new Error('skip'));
    fetchOverpassPlaces(catId, c).then(p => res({ p, viaPhoton: false }), rej);
  }, 2500));
  let result;
  try { result = await Promise.any([photon, overpass]); }
  catch {
    settled = true;
    if (seq !== placeSeq) return;
    if (tile.length) { $('placeStatus').textContent = 'Rādītas vietas no kartes (meklēšanas serveri šobrīd neatbild).'; return; }
    $('placeStatus').textContent = 'Neizdevās ielādēt vietas. ';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'link-btn'; retry.textContent = 'Mēģināt vēlreiz';
    retry.addEventListener('click', () => showPlaces(catId));
    $('placeStatus').appendChild(retry);
    return;
  }
  settled = true;
  let places = result.p.slice(0, 25);
  if (!places.length && tile.length) places = tile;     // tīklā nekas — paliek kartes vietas
  cachePut('places', key, places);
  if (seq !== placeSeq) return;
  $('placeStatus').textContent = placesStatusText(places, c);
  renderPlaces(places, catId, c, !tile.length);
  if (!result.viaPhoton || !places.length) return;
  // Fonā: darba laiks (krāsainais punkts), maksa, vietu skaits
  await enrichPlaces(places, key, catId, c, seq);
}
function goToPlace(p) {
  closePlaces();
  const label = placeLabelOne(p.cat);
  // F24: ja nosaukums jau ir kategorija („Elektroauto uzlāde · Elektrum”), to otrreiz nerāda
  selectDestination({ name: p.name, sub: [p.addr, p.name.startsWith(label) ? '' : label].filter(Boolean).join(', '), lat: p.lat, lng: p.lng, ct: p.ct || null });
}
function wirePlaces() {
  const icons = $('placesBtnIcons');
  for (const id of ['fuel', 'parking', 'food', 'coffee']) icons.insertAdjacentHTML('beforeend', placeIconSvg(id, 26));
  const ul = $('placeCats');
  for (const c of PLACE_CATEGORIES) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'place-cat';
    b.innerHTML = placeIconSvg(c.id, 34) + '<span></span><svg class="pc-chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.querySelector('span').textContent = c.label;
    b.addEventListener('click', () => showPlaces(c.id));
    li.appendChild(b); ul.appendChild(li);
  }
  $('placesBtn').addEventListener('click', openPlaces);
  $('placesBack').addEventListener('click', showPlaceCats);
  $('closePlaces').addEventListener('click', closePlaces);
  if (typeof ridesInit === 'function') ridesInit();      // kopbraucieni (rides-ui.js)
}
