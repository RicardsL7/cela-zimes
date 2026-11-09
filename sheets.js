// A12: paneļu („sheet”) un dialogu pieejamība ar tastatūru un ekrāna lasītāju.
// Paneļus atver/aizver daudzās vietās ar el.hidden = …, tāpēc šis modulis neko tur nemaina — tas vēro atribūtu „hidden”
// (MutationObserver) un, kad panelis atveras:
//   • iestata dialoga semantiku (role="dialog", aria-modal — modālajiem),
//   • pārvieto fokusu panelī (uz virsrakstu — ekrāna lasītājs to nolasa; vai uz pirmo pogu dialogā bez virsraksta),
//   • modālajiem: fons ekrāna lasītājam paslēpts (aria-hidden), Tab un Shift+Tab riņķo tikai panelī,
//     pilnekrāna pārklājumiem (piekrišana, Garāžas pirkums) fons arī „inert”,
//   • Esc aizver augšējo paneli (piekrišanu — ne),
//   un, kad aizveras: fokuss atgriežas uz pogas, ar ko atvēra (vai uz paneļa pogu rīkjoslā).
// Pele / pirksts ar karti strādā kā līdz šim: stāvēšanas un vietu paneļi ir ne-modāli (tajos izvēlas vietu kartē),
// un arī modālo paneļu laikā karti var pavilkt — tāpēc fonam „inert” uzliek tikai pilnekrāna pārklājumiem.
const CZ_SHEETS = {
  // id: [veids, aizvēršanas poga, poga rīkjoslā (fokusam atpakaļ un aria-expanded)]
  settings:    ['modal',   'closeSettings', 'settingsBtn'],
  reportSheet: ['modal',   'closeReport',   'reportBtn'],
  gpsSheet:    ['modal',   'closeGpsHelp',  'gpsHelpBtn'],
  garageSheet: ['modal',   'closeGarage',   'garageBtn'],
  ridesSheet:  ['modal',   'closeRides',    'ridesBtn'],
  parkSheet:   ['panel',   'closePark',     'parkBtn'],
  placesSheet: ['panel',   'closePlaces',   'placesBtn'],
  garageDlg:   ['overlay', null,            null],
  consentGate: ['overlay', null,            null],
};
const czSh = { stack: [], openers: new Map(), lastOutside: null, hidden: [], ready: false };
const CZ_FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

function czShVisible(el) {
  return !!el && el.isConnected && !el.closest('[hidden]') && el.getClientRects().length > 0;
}
// Aizvērtas <details> saturs (izņemot tās virsrakstu summary) Tab secībā nav, lai gan pārlūks to var skaitīt redzamu
// (B04: „Datu avoti” tagad ar saitēm — bez šī fokuss no paneļa izkrita)
function czShInClosedDetails(el) {
  for (let d = el.closest('details'); d; d = d.parentElement ? d.parentElement.closest('details') : null) {
    if (!d.open && !(el.tagName === 'SUMMARY' && el.parentElement === d)) return true;
  }
  return false;
}
function czShFocusables(root) {
  return [...root.querySelectorAll(CZ_FOCUSABLE)].filter(el => !el.disabled && el.tabIndex >= 0 && czShVisible(el)
    && !el.closest('[inert], [aria-hidden="true"]') && !czShInClosedDetails(el));
}
// Augšējais atvērtais: pilnekrāna pārklājumi vienmēr virs paneļiem (piekrišana — virs visa)
function czShTop() {
  for (const id of ['consentGate', 'garageDlg']) if (czSh.stack.includes(id)) return id;
  return czSh.stack[czSh.stack.length - 1] || null;
}
function czShType(id) { return (CZ_SHEETS[id] || [])[0]; }

// Kur likt fokusu, kad panelis atveras: virsraksts (aria-labelledby vai pirmais redzamais h2), citādi pirmā poga
function czShFocusTarget(el) {
  const lb = el.getAttribute('aria-labelledby');
  let h = lb && document.getElementById(lb);
  if (!czShVisible(h)) h = [...el.querySelectorAll('h2, .gr-dlg-t')].find(czShVisible);
  if (h) { if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1'); return h; }
  const f = czShFocusables(el)[0];
  if (f) return f;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  return el;
}
function czShFocusInto(id) {
  const el = document.getElementById(id);
  if (!el || el.hidden) return;
  const a = document.activeElement;                      // kods jau fokusēja ko redzamu panelī (piem. ievadi)
  if (a && a !== el && el.contains(a) && czShVisible(a)) return;
  try { czShFocusTarget(el).focus({ preventScroll: true }); } catch (e) { /* vecs pārlūks */ }
}

// Fons ekrāna lasītājam (un pārklājumiem — arī pelei/tastatūrai): visi brāļi ceļā no paneļa līdz <body>
function czShRestoreBackground() {
  for (const [el, aria, inert] of czSh.hidden) {
    if (aria === null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', aria);
    if (inert) el.inert = false;
  }
  czSh.hidden = [];
}
function czShApplyBackground() {
  czShRestoreBackground();
  const id = czShTop(), type = czShType(id);
  if (!id || type === 'panel') return;
  const el = document.getElementById(id);
  for (let node = el; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sib of node.parentElement.children) {
      if (sib === node || sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE') continue;
      if (sib.getAttribute('aria-hidden') === 'true' && !(type === 'overlay' && !sib.inert)) continue;
      czSh.hidden.push([sib, sib.getAttribute('aria-hidden'), type === 'overlay' && !sib.inert]);
      sib.setAttribute('aria-hidden', 'true');
      if (type === 'overlay') sib.inert = true;
    }
  }
}
function czShSyncExpanded(id, open) {
  const b = document.getElementById((CZ_SHEETS[id] || [])[2]);
  if (b && b.hasAttribute('aria-controls')) b.setAttribute('aria-expanded', String(open));
}

function czShOpened(id) {
  czSh.stack = czSh.stack.filter(x => x !== id).concat(id);
  const a = document.activeElement;
  // Kas atvēra: fokusētā poga ārpus paneļa (tastatūra), citādi pēdējā nospiestā (pele / pirksts)
  const opener = a && a !== document.body && !document.getElementById(id).contains(a) ? a : czSh.lastOutside;
  czSh.openers.set(id, opener && opener.isConnected ? opener : null);
  czShSyncExpanded(id, true);
  czShApplyBackground();
  // Saturu daži paneļi aizpilda tajā pašā solī pēc atvēršanas — fokusē pēc tā (ne kadrā: smagas kartes laikā kadri kavējas)
  setTimeout(() => { if (czShTop() === id) czShFocusInto(id); }, 0);
}
function czShClosed(id) {
  const wasTop = czShTop() === id;
  czSh.stack = czSh.stack.filter(x => x !== id);
  czShSyncExpanded(id, false);
  czShApplyBackground();
  const el = document.getElementById(id), a = document.activeElement;
  // Fokusu atgriež tikai tad, ja tas palika aizvērtajā panelī vai pazuda (nevis ja lietotājs jau ir citur)
  if (!(a === document.body || a === null || (el && el.contains(a)) || !czShVisible(a))) return;
  const next = czShTop();
  if (next && next !== id && !wasTop) return;
  const opener = czSh.openers.get(id);
  const fallback = document.getElementById((CZ_SHEETS[id] || [])[2]);
  const target = [opener, fallback].find(x => czShVisible(x) && !x.closest('[inert]') && !(next && !document.getElementById(next).contains(x)));
  if (target) target.focus({ preventScroll: true });
  else if (next) czShFocusInto(next);
  else if (a && el && el.contains(a)) a.blur();
}

function czShKeydown(e) {
  const id = czShTop();
  if (!id || e.defaultPrevented) return;
  const el = document.getElementById(id), type = czShType(id);
  if (e.key === 'Escape') {
    if (id === 'consentGate') return;                    // bez piekrišanas lietotni lietot nevar — ar Esc neaizver
    const a = document.activeElement;                    // raksta meklēšanā ārpus paneļa — Esc pieder tai
    if (a && !el.contains(a) && a.matches && a.matches('input, textarea, select')) return;
    e.preventDefault();
    const btn = document.getElementById((CZ_SHEETS[id] || [])[1]);
    if (btn && czShVisible(btn)) btn.click(); else el.hidden = true;
    return;
  }
  if (e.key !== 'Tab' || type === 'panel' || !el.contains(document.activeElement)) return;
  const f = czShFocusables(el);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !f.includes(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !f.includes(a))) { e.preventDefault(); first.focus(); }
}

function czSheetsInit() {
  if (czSh.ready) return;
  czSh.ready = true;
  // Pēdējais elements, ar ko lietotājs darbojās ārpus paneļiem (pirkstam pogas fokusu nedod) — fokusam atpakaļ
  const remember = e => {
    const t = e.target && e.target.closest && e.target.closest(CZ_FOCUSABLE);
    if (t && !Object.keys(CZ_SHEETS).some(id => { const s = document.getElementById(id); return s && s.contains(t); })) czSh.lastOutside = t;
  };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('focusin', remember, true);
  document.addEventListener('keydown', czShKeydown);
  const obs = new MutationObserver(list => {
    for (const m of list) {
      const id = m.target.id;
      if (!(id in CZ_SHEETS) || m.attributeName !== 'hidden') continue;
      const open = !m.target.hidden, known = czSh.stack.includes(id);
      if (open && !known) czShOpened(id); else if (!open && known) czShClosed(id);
    }
    // Panelī nomainījās saturs (piem. piekrišanas solis, Garāžas dialogs) un fokuss pazuda — atpakaļ panelī
    const top = czShTop();
    if (top && czShType(top) !== 'panel' && !czShVisible(document.activeElement)) setTimeout(() => {
      if (czShTop() === top && !czShVisible(document.activeElement)) czShFocusInto(top);
    }, 0);
  });
  for (const [id, [type]] of Object.entries(CZ_SHEETS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'dialog');
    if (type !== 'panel') el.setAttribute('aria-modal', 'true'); else el.removeAttribute('aria-modal');
    obs.observe(el, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    if (!el.hidden) czShOpened(id);                      // jau atvērts (piem. piekrišana pirms šī skripta)
  }
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', czSheetsInit); else czSheetsInit();
}
