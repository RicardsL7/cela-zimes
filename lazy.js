// Ceļa Zīmes — vēlā ielāde (audits 2, B15).
//
// „Kopā” (rides.js, rides-ui.js), stāvēšana (parking.js, park-gl.js, park-dest-gl.js) un Garāža ar tēliem un citiem
// braucējiem (skins-art.js, skins.js, garage.js, presence.js) — ≈ 1/3 lietotnes koda — kartes palaišanai nav vajadzīgi.
// HTML tie ir kā <script type="text/x-cz-lazy" src="…"> (pārlūks tos neielādē un neizpilda; sw.js tos tik un tā saglabā
// bezsaistei). Kad app-gl.js init() beidzies (czLazyStart), šis fails tos ielādē tādā pašā secībā kā līdz šim un pēc
// faila izsauc tā data-init funkciju (ridesInit, garageInit, presenceInit) — tieši kā app-gl.js to darīja agrāk.
// Ja kāds uzspiež „Kopā” / „Garāža” / „Stāvēt” pirms ielādes — spiediens tiek atcerēts un izpildīts, kad gatavs.
// Rezerve: ja init() nav izsaucis czLazyStart (kļūda), ielāde sākas pēc lapas „load”.

const CZ_LAZY = { started: false, done: new Set(), failed: new Set(), pending: new Map(), queue: [] };
// Poga → fails, pēc kura ielādes tā strādā (park-gl.js pogas pieslēdz pats ≤ 150 ms pēc ielādes — tāpēc pauze)
const CZ_LAZY_BTNS = { ridesBtn: ['rides-ui.js', 0], garageBtn: ['garage.js', 0], parkBtn: ['park-gl.js', 400], destParkBtn: ['park-dest-gl.js', 500] };

function czLazyName(src) { return String(src || '').replace(/[?#].*$/, '').replace(/^.*\//, ''); }

function czLazyItems(doc) {
  return [...doc.querySelectorAll('script[type="text/x-cz-lazy"]')].map(s => ({ src: s.getAttribute('src'), init: s.getAttribute('data-init') || '' }));
}

function czLazyRun(w, name, fn) {
  try { if (fn && typeof w[fn] === 'function') w[fn](); }
  catch (e) { console.error('[lazy] ' + fn, e); if (typeof w.czReportError === 'function') w.czReportError(e, 'lazy ' + fn); }
  CZ_LAZY.done.add(name);
  const p = CZ_LAZY.pending.get(name);
  if (p) {
    CZ_LAZY.pending.delete(name);
    w.setTimeout(() => { const b = w.document.getElementById(p.id); if (b) b.click(); }, p.delay);
  }
}

// Ielādē pēc kārtas (async=false — izpildes secība = pievienošanas secība, kā defer skriptiem)
function czLazyStart(w = (typeof window !== 'undefined' ? window : null)) {
  if (!w || CZ_LAZY.started) return false;
  CZ_LAZY.started = true;
  const d = w.document;
  const items = czLazyItems(d);
  CZ_LAZY.queue = items.map(i => czLazyName(i.src));
  for (const it of items) {
    const name = czLazyName(it.src);
    const s = d.createElement('script');
    s.src = it.src;
    s.async = false;
    s.addEventListener('load', () => czLazyRun(w, name, it.init));
    s.addEventListener('error', () => { CZ_LAZY.failed.add(name); console.warn('[lazy] neielādējās ' + name); });
    d.body.appendChild(s);
  }
  return true;
}

// Spiediens uz pogas, kuras kods vēl nav ielādēts — atceras un parāda, ka ielādējas
function czLazyGuard(w) {
  const d = w.document;
  d.addEventListener('click', ev => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button[id]') : null;
    const cfg = btn && CZ_LAZY_BTNS[btn.id];
    if (!cfg || CZ_LAZY.done.has(cfg[0])) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (CZ_LAZY.failed.has(cfg[0])) { if (typeof w.czToast === 'function') w.czToast('Neizdevās ielādēt — pārbaudi internetu un atver lietotni vēlreiz.', true); return; }
    CZ_LAZY.pending.set(cfg[0], { id: btn.id, delay: cfg[1] });
    if (typeof w.czToast === 'function') w.czToast('Ielādē…');
    if (!CZ_LAZY.started) czLazyStart(w);
  }, true);
}

if (typeof window !== 'undefined' && window.document && typeof window.addEventListener === 'function') {
  czLazyGuard(window);
  window.addEventListener('load', () => window.setTimeout(() => czLazyStart(window), 0));
}
if (typeof module !== 'undefined') module.exports = { CZ_LAZY, CZ_LAZY_BTNS, czLazyStart, czLazyItems, czLazyName, czLazyRun, czLazyGuard };
