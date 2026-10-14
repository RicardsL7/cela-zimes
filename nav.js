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
async function requestRoute(from, to) {
  const url = `${OSRM_URL}${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&geometries=geojson&steps=true`;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), 15000);     // ilgāk par 15 s negaida
  let data;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } finally { if (timer) clearTimeout(timer); }
  if (!data.routes || !data.routes.length) throw new Error('Maršruts nav atrasts');
  const r = data.routes[0];
  const steps = r.legs.flatMap(l => l.steps);
  // Visu soļu līnijas vienā sarakstā + kur katrs solis sākas.
  const coords = [];
  for (const st of steps) {
    const c = st.geometry.coordinates;
    st._start = Math.max(0, coords.length - 1);
    for (let i = coords.length ? 1 : 0; i < c.length; i++) coords.push(c[i]);
  }
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + metersBetween(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  return { coords, cum, steps, distance: r.distance, duration: r.duration, lastIdx: 0 };
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

if (typeof module !== 'undefined') module.exports = { routePointAt, routeRemaining, smoothProgress, locateOnRoute, routeProgress };
