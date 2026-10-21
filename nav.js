// Navigācija: maršruts (OSRM), pagriezienu norādes latviski un progress pa maršrutu.

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';

function navDist(m) {
  if (m >= 975) return (m / 1000).toLocaleString('lv-LV', { maximumFractionDigits: m >= 10000 ? 0 : 1 }) + ' km';
  if (m >= 100) return Math.round(m / 50) * 50 + ' m';
  return Math.max(10, Math.round(m / 10) * 10) + ' m';
}
function navTime(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
}

// Pieprasa maršrutu un sagatavo to sekošanai.
async function osrmFetch(pts, extra = '') {
  const url = `${OSRM_URL}${pts.map(p => p.lng + ',' + p.lat).join(';')}?overview=false&geometries=geojson&steps=true${extra}`;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), 15000);     // ilgāk par 15 s negaida
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { if (timer) clearTimeout(timer); }
}

// OSRM maršruts → { coords, cum, steps, distance, duration }.
// Ja maršrutam ir starppunkts (alternatīvai), tā "ieradies/sāc" soļus izmet — vadītājam tie nav vajadzīgi.
function parseOsrmRoute(r) {
  const all = r.legs.flatMap(l => l.steps);
  const coords = [];
  for (const st of all) {
    const c = st.geometry.coordinates;
    st._start = Math.max(0, coords.length - 1);
    for (let i = coords.length ? 1 : 0; i < c.length; i++) coords.push(c[i]);
  }
  const last = all.length - 1;
  const steps = all.filter((st, i) => {
    const t = st.maneuver && st.maneuver.type;
    return !((t === 'arrive' && i < last) || (t === 'depart' && i > 0));
  });
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + metersBetween(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  return { coords, cum, steps, distance: r.distance, duration: r.duration, lastIdx: 0 };
}

async function requestRoute(from, to) {
  const data = await osrmFetch([from, to]);
  if (!data.routes || !data.routes.length) throw new Error('Maršruts nav atrasts');
  return parseOsrmRoute(data.routes[0]);
}

// ---------- Alternatīvie maršruti ----------
// Maršruta "pēdas" — ~50 m režģa šūnas, pa kurām tas iet.
function routeCells(route) {
  const set = new Set(), first = new Map(), { coords, cum } = route;
  let samples = 0, again = 0;
  for (let i = 1; i < coords.length; i++) {
    const n = Math.max(1, Math.ceil((cum[i] - cum[i - 1]) / 25));
    for (let k = 0; k <= n; k++) {
      const lng = coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * k / n;
      const lat = coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * k / n;
      const c = Math.round(lat / 0.00045) + ':' + Math.round(lng / 0.0008), at = cum[i - 1] + (cum[i] - cum[i - 1]) * k / n;
      samples++;
      if (!first.has(c)) first.set(c, at); else if (at - first.get(c) > 250) again++;   // atgriežas tur, kur jau bijis
      set.add(c);
    }
  }
  set.backtrack = samples ? again / samples : 0;
  return set;
}
// Cik liela daļa no maršruta a iet pa to pašu ceļu, kur b (0…1).
function routeOverlap(a, b) {
  const ca = a._cells || (a._cells = routeCells(a)), cb = b._cells || (b._cells = routeCells(b));
  let same = 0;
  for (const c of ca) if (cb.has(c) || cb.has(nearCell(c, 1, 0)) || cb.has(nearCell(c, -1, 0)) || cb.has(nearCell(c, 0, 1)) || cb.has(nearCell(c, 0, -1))) same++;
  return ca.size ? same / ca.size : 1;
}
function nearCell(c, dy, dx) { const [y, x] = c.split(':').map(Number); return (y + dy) + ':' + (x + dx); }

// Apgriešanās skaits ne pašā sākumā/galā.
function routeUturns(r) {
  const total = r.cum[r.cum.length - 1];
  return r.steps.filter(st => st.maneuver && st.maneuver.modifier === 'uturn' && st.maneuver.type !== 'depart'
    && r.cum[st._start] > 400 && r.cum[st._start] < total - 400).length;
}
// Atlasa līdz max maršrutiem: tikai tādus, kas tiešām atšķiras un nav daudz garāki par ātrāko.
function pickAlternatives(routes, max = 3) {
  const list = routes.filter(r => r && r.coords && r.coords.length > 1).sort((a, b) => a.duration - b.duration);
  if (!list.length) return [];
  const best = list[0], out = [best];
  for (const r of list.slice(1)) {
    if (out.length >= max) break;
    if (r.duration > best.duration * 1.45 + 120 || r.distance > best.distance * 1.6 + 1000) continue;
    if (routeUturns(r) > routeUturns(best)) continue;        // lieka apgriešanās (apkārtceļš turp un atpakaļ)
    if (out.some(o => routeOverlap(r, o) > 0.8)) continue;
    if (r._cells.backtrack > 0.05) continue;                 // brauc turp un atpakaļ pa to pašu ceļu
    out.push(r);
  }
  for (const r of out) delete r._cells;     // kešatmiņā nav vajadzīgs
  return out;
}

// Starppunkti apkārtceļiem: abās pusēs taisnei starp sākumu un galu.
function detourPoints(from, to) {
  const cos = Math.cos(from.lat * Math.PI / 180);
  const dx = (to.lng - from.lng) * cos, dy = to.lat - from.lat, d = Math.hypot(dx, dy);
  if (!d) return [];
  const off = Math.min(Math.max(d * 0.22, 0.006), 0.03);        // ~0,7–3,3 km sānis
  const out = [];
  for (const f of [0.5, 0.35]) for (const side of [1, -1]) {
    const mx = from.lng + (to.lng - from.lng) * f, my = from.lat + (to.lat - from.lat) * f;
    out.push({ lat: my + side * off * dx / d, lng: mx - side * off * dy / d / cos });
  }
  return out;
}

// Laiks ar sastrēgumiem.
const routeEta = r => r.duration + (r.jamSec || 0);

// Nosaukumi sarakstam: Ātrākais / Īsākais / Mazāk sastrēgumu / Alternatīva.
function labelRoutes(routes) {
  if (!routes.length) return [];
  const fast = routes.reduce((a, b) => routeEta(b) < routeEta(a) ? b : a);
  const lbl = new Map([[fast, 'Ātrākais']]);
  const short = routes.reduce((a, b) => b.distance < a.distance ? b : a);
  if (short !== fast && short.distance < fast.distance - 300) lbl.set(short, 'Īsākais');
  if ((fast.jamSec || 0) >= 60) {
    const calm = routes.filter(r => !lbl.has(r)).sort((a, b) => (a.jamSec || 0) - (b.jamSec || 0))[0];
    if (calm && (calm.jamSec || 0) < fast.jamSec - 60) lbl.set(calm, 'Mazāk sastrēgumu');
  }
  return routes.map(r => lbl.get(r) || 'Alternatīva');
}

// Vieta uzrakstam uz maršruta: tās daļas vidū, kur tas atšķiras no pārējiem.
function routeLabelPoint(route, others) {
  const cells = others.map(o => routeCells(o));
  const { coords, cum } = route, own = [];
  for (let i = 0; i < coords.length; i++) {
    const c = Math.round(coords[i][1] / 0.00045) + ':' + Math.round(coords[i][0] / 0.0008);
    if (!cells.some(set => set.has(c) || set.has(nearCell(c, 1, 0)) || set.has(nearCell(c, -1, 0)) || set.has(nearCell(c, 0, 1)) || set.has(nearCell(c, 0, -1)))) own.push(i);
  }
  if (own.length) return coords[own[Math.floor(own.length / 2)]];
  const half = cum[cum.length - 1] / 2;
  const p = routePointAt(route, half);
  return [p.lng, p.lat];
}

// 2–3 maršruti: OSRM alternatīvas; ja to nav, mēģina caur starppunktiem.
async function requestRoutes(from, to, max = 3) {
  const data = await osrmFetch([from, to], '&alternatives=' + max);
  if (!data.routes || !data.routes.length) throw new Error('Maršruts nav atrasts');
  let routes = pickAlternatives(data.routes.map(parseOsrmRoute), max);
  if (routes.length < 2 && metersBetween(from.lat, from.lng, to.lat, to.lng) > 1500) {
    const vias = detourPoints(from, to);
    const extra = [];
    for (let i = 0; i < vias.length && extra.length < 2; i += 2) {      // vispirms vidū, tad tuvāk sākumam
      const got = await Promise.all(vias.slice(i, i + 2).map(v =>
        osrmFetch([from, v, to], '&continue_straight=true').then(d => d.routes && d.routes[0] && parseOsrmRoute(d.routes[0])).catch(() => null)));
      extra.push(...got.filter(Boolean));
      routes = pickAlternatives(routes.concat(extra), max);
      if (routes.length >= 2) break;
    }
  }
  return routes;
}

function metersBetween(lat1, lng1, lat2, lng2) {
  const k = 111320, x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * k;
  return Math.hypot(x, y);
}

// Kur uz maršruta es esmu? Atgriež { idx, t, off (m no maršruta), along (m no sākuma) }.
function locateOnRoute(route, lat, lng) {
  const { coords, cum } = route;
  const from = Math.max(0, route.lastIdx - 30), to = Math.min(coords.length - 1, route.lastIdx + 400);
  const k = 111320, cos = Math.cos(lat * Math.PI / 180);
  let best = { off: Infinity };
  const scan = (a, b) => {
    for (let i = a; i < b; i++) {
      const ax = (coords[i][0] - lng) * k * cos, ay = (coords[i][1] - lat) * k;
      const bx = (coords[i + 1][0] - lng) * k * cos, by = (coords[i + 1][1] - lat) * k;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const off = Math.hypot(ax + t * dx, ay + t * dy);
      if (off < best.off) best = { idx: i, t, off };
    }
  };
  scan(from, to);
  if (best.off > 80) scan(0, coords.length - 1); // pazaudēts: meklē visā maršrutā
  best.along = cum[best.idx] + best.t * (cum[best.idx + 1] - cum[best.idx]);
  route.lastIdx = best.idx;
  return best;
}

// Teksts nākamajam manevram latviski.
function maneuverText(step) {
  const m = step.maneuver || {}, type = m.type, mod = m.modifier || '';
  const name = step.name || step.ref || '';
  const onto = name ? `: ${name}` : '';   // iela pēc kola — bez locījuma problēmām
  const side = /left/.test(mod) ? 'pa kreisi' : /right/.test(mod) ? 'pa labi' : '';
  const turn = mod.startsWith('slight') ? 'Nogriezies ' : mod.startsWith('sharp') ? 'Strauji pagriezies ' : 'Pagriezies ';
  switch (type) {
    case 'depart': return name ? `Sāc braucienu: ${name}` : 'Dodies ceļā';
    case 'arrive': return 'Galamērķis';
    case 'roundabout': case 'rotary': case 'exit roundabout': case 'exit rotary':
      return m.exit ? `Aplī izbrauc ${m.exit}. izbrauktuvē${onto}` : `Brauc pa apli${onto}`;
    case 'merge': return `Iekļaujies satiksmē ${side}`.trim() + onto;
    case 'on ramp': return `Brauc uzbrauktuvē ${side}`.trim() + onto;
    case 'off ramp': return `Nobrauc ${side}`.trim() + onto;
    case 'fork': return `Turies ${side || 'taisni'}${onto}`;
    case 'end of road': return `Ceļa galā pagriezies ${side}${onto}`;
    case 'continue': case 'new name':
      if (mod === 'straight' || !side) return `Turpini taisni${onto}`;
      return turn + side + onto;
    case 'turn': default:
      if (mod === 'uturn') return 'Apgriezies';
      if (mod === 'straight' || !side) return `Turpini taisni${onto}`;
      return turn + side + onto;
  }
}

// Bultas ikona manevram (SVG).
function maneuverIcon(step) {
  const m = step.maneuver || {}, mod = m.modifier || 'straight', type = m.type;
  let rot = { 'straight': 0, 'slight right': 35, 'right': 90, 'sharp right': 135, 'slight left': -35, 'left': -90, 'sharp left': -135, 'uturn': 180 }[mod] ?? 0;
  if (type === 'arrive') {
    return '<svg viewBox="0 0 48 48"><path d="M24 4c-7.7 0-14 6-14 13.6C10 28 24 44 24 44s14-16 14-26.4C38 10 31.7 4 24 4Z" fill="currentColor"/><circle cx="24" cy="17.5" r="5.5" fill="var(--nav-bg)"/></svg>';
  }
  if (type === 'roundabout' || type === 'rotary') {
    return '<svg viewBox="0 0 48 48"><circle cx="24" cy="26" r="9" fill="none" stroke="currentColor" stroke-width="5"/><path d="M24 17V4m-7 7 7-7 7 7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 35v10" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>';
  }
  if (mod === 'uturn') {
    return '<svg viewBox="0 0 48 48"><path d="M30 44V20a10 10 0 0 0-20 0v6" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="m3 20 7 8 7-8" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return `<svg viewBox="0 0 48 48"><g transform="rotate(${rot} 24 26)"><path d="M24 44V10" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/><path d="m13 20 11-12 11 12" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

// Progress: nākamais manevrs, attālums līdz tam, atlikušais ceļš un laiks.
function routeProgress(route, lat, lng) {
  const loc = locateOnRoute(route, lat, lng);
  const total = route.cum[route.cum.length - 1];
  const remaining = Math.max(0, total - loc.along);
  let next = null;
  for (const st of route.steps) {
    if (route.cum[st._start] > loc.along + 5) { next = st; break; }
  }
  if (!next) next = route.steps[route.steps.length - 1];
  const toNext = Math.max(0, route.cum[next._start] - loc.along);
  const timeLeft = route.duration * (total ? remaining / total : 0);
  return { loc, next, toNext, remaining, timeLeft, arrived: remaining < 25 };
}

// ---------- Nobrauktā / atlikušā maršruta daļa ----------
// Punkts uz maršruta pēc nobrauktā attāluma (metri no sākuma) — pa maršruta punktiem,
// nevis taisnā līnijā. Atgriež { lng, lat, idx, t, bearing }.
function routePointAt(route, along) {
  const { coords, cum } = route;
  const n = coords.length;
  if (n < 2) return { lng: coords[0][0], lat: coords[0][1], idx: 0, t: 0, bearing: 0 };
  const total = cum[n - 1];
  const a = Math.max(0, Math.min(total, along));
  let lo = 0, hi = n - 2;                       // meklē posmu: cum[i] <= a <= cum[i + 1]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= a) lo = mid; else hi = mid - 1;
  }
  const i = lo, len = cum[i + 1] - cum[i];
  const t = len > 0 ? (a - cum[i]) / len : 0;
  const p = coords[i], q = coords[i + 1];
  const cos = Math.cos(p[1] * Math.PI / 180);
  const bearing = (Math.atan2((q[0] - p[0]) * cos, q[1] - p[1]) * 180 / Math.PI + 360) % 360;
  return { lng: p[0] + (q[0] - p[0]) * t, lat: p[1] + (q[1] - p[1]) * t, idx: i, t, bearing };
}

// Vēl nenobrauktā maršruta daļa: no punkta "along" līdz galamērķim (ar visiem līkumiem).
function routeRemaining(route, along) {
  if (along == null || along <= 0) return route.coords;
  const p = routePointAt(route, along);
  const out = [[p.lng, p.lat]];
  for (let i = p.idx + 1; i < route.coords.length; i++) out.push(route.coords[i]);
  if (out.length === 1) out.push([p.lng, p.lat]);   // galamērķis sasniegts — tukša līnija
  return out;
}

// Progress bez lēkāšanas: GPS svārstības atpakaļ (līdz maxBack m) neņem vērā,
// lai nobrauktā līnija neparādītos atkal. Lielāks solis atpakaļ — īsts (piem. pēc pārrēķina).
function smoothProgress(prev, next, maxBack = 30) {
  if (prev == null || next == null) return next;
  if (next >= prev) return next;
  return prev - next <= maxBack ? prev : next;
}

if (typeof module !== 'undefined') module.exports = { routeEta, labelRoutes, routeLabelPoint, parseOsrmRoute, pickAlternatives, routeOverlap, detourPoints, routePointAt, routeRemaining, smoothProgress, locateOnRoute, routeProgress };
