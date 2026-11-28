// Ceļa Zīmes — valodas (audits 2, B20): latviešu (pamata), angļu, krievu. Citas valodas — pārlūka tulkotājs no angļu.
//
// Kā strādā: viss lietotnes kods raksta latviski (kā līdz šim). Šis fails (ielādējas pirmais, <head>) pēc izvēlētās
// valodas ielādē vārdnīcu (i18n-en.js / i18n-ru.js: „latviešu teksts” → tulkojums) un tulko lapā redzamo tekstu un
// atribūtus (title, aria-label, placeholder, alt) — arī visu, ko kods pievieno vēlāk (MutationObserver). Teksti ar
// mainīgajiem: vārdnīcā {*} (piem. „Atmaksāts {*}” → „Refunded {*}”); tulkojumā {1}, {2} — ja secība cita.
// Netulko: elementus ar data-noi18n vai translate="no" (lietotāju teksts — čats, vārdi, adreses), ievades laukus.
// Nav tulkojuma → paliek latviski (nekas nesalūst). tools/i18n-extract.mjs + tests/run.js pārbauda, ka tulkojumi ir visiem.
//
// Valoda: ?lang=xx → saglabātā izvēle (localStorage cz.lang) → pārlūka valodas. Pirmajā atvēršanā — izvēles logs
// (pirms noteikumu piekrišanas). Mainot valodu, lapa pārlādējas. Datu (servera) un koda loģika valodu nezina.
(function (w) {
  'use strict';
  const LANGS = ['lv', 'en', 'ru'];
  const LOCALE = { lv: 'lv-LV', en: 'en-GB', ru: 'ru-RU' };
  const KEY = 'cz.lang';
  const d = w.document;

  function get(k) { try { return w.localStorage.getItem(k); } catch { return null; } }
  function set(k, v) { try { w.localStorage.setItem(k, v); } catch { /* privātais režīms */ } }

  // Pārlūka valodas → mūsu valoda: latviešu, ja tā ir sarakstā; krievu, ja tā ir pirmā; citādi angļu (pārlūks to var
  // pārtulkot uz lietotāja valodu). Tas ir tikai priekšlikums — pirmajā atvēršanā cilvēks izvēlas pats.
  function czLangGuess(list) {
    const l = (list || []).map(x => String(x || '').toLowerCase().slice(0, 2)).filter(Boolean);
    if (!l.length || l.includes('lv')) return 'lv';
    return l[0] === 'ru' ? 'ru' : 'en';
  }

  function czLangPick(search, saved, nav) {
    const q = /[?&]lang=(lv|en|ru)\b/.exec(search || '');
    if (q) return { lang: q[1], chosen: true, fromUrl: true };
    if (LANGS.includes(saved)) return { lang: saved, chosen: true };
    return { lang: czLangGuess(nav), chosen: false };
  }

  // --- Tulkotājs ---
  function compile(dict) {
    const exact = new Map(), pats = [];
    for (const [k, v] of Object.entries(dict || {})) {
      if (typeof v !== 'string') continue;
      if (k.includes('{*}')) {
        if (!/[A-Za-zĀ-ž]/.test(k.replace(/\{\*\}/g, ''))) continue;      // „{*} {*}” — der visam, nelieto
        const parts = k.split('{*}');
        const re = new RegExp('^' + parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)') + '$');
        pats.push({ re, v, lit: k.replace(/\{\*\}/g, '').length });
      } else exact.set(k, v);
    }
    pats.sort((a, b) => b.lit - a.lit);           // garākais nemainīgais teksts — precīzākais
    return { exact, pats };
  }

  function fill(tpl, args, tr) {
    let i = 0;
    return tpl.replace(/\{(\*|\d)\}/g, (m, k) => {
      const a = k === '*' ? args[i++] : args[+k - 1];
      return a == null ? '' : tr(a);
    });
  }

  function czI18nMake(dict) {
    const c = compile(dict);
    // Iekšējie (mainīgo) gabali: tikai precīzi tulkojumi (tēla vārds, „braucieni”), lai nav bezgalīgas rekursijas
    const inner = s => { const t = s.trim(); const v = c.exact.get(t); return v == null ? s : s.replace(t, v); };
    function tr(s) {
      if (typeof s !== 'string' || !s) return s;
      const lead = /^\s*/.exec(s)[0], trail = /\s*$/.exec(s.slice(lead.length))[0];
      const core = s.slice(lead.length, s.length - trail.length);
      if (!core || !/[A-Za-zĀ-žА-я]/.test(core)) return s;
      const key = core.replace(/\s+/g, ' ');
      let v = c.exact.get(key);
      if (v == null) {
        for (const p of c.pats) { const m = p.re.exec(key); if (m) { v = fill(p.v, m.slice(1), inner); break; } }
      }
      return v == null ? s : lead + v + trail;
    }
    return { tr, size: c.exact.size + c.pats.length };
  }

  // --- DOM ---
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
  const SKIP_TAG = /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE|NOSCRIPT|svg|path)$/;
  function czI18nDom(root, tr) {
    const seen = new WeakMap();                    // teksta mezgls → mūsu ierakstītais tulkojums
    const seenA = new WeakMap();                   // elements → { atribūts: mūsu tulkojums }
    const skip = el => { for (let e = el; e && e.nodeType === 1; e = e.parentNode) { if (SKIP_TAG.test(e.nodeName) || e.hasAttribute('data-noi18n') || e.getAttribute('translate') === 'no' || e.isContentEditable) return true; } return false; };
    function text(n) {
      if (!n.parentNode || skip(n.parentNode)) return;
      const cur = n.nodeValue;
      if (seen.get(n) === cur) return;
      const out = tr(cur);
      seen.set(n, out);
      if (out !== cur) n.nodeValue = out;
    }
    function attrs(el) {
      if (skip(el)) return;
      let m = seenA.get(el); if (!m) { m = {}; seenA.set(el, m); }
      for (const a of ATTRS) {
        const cur = el.getAttribute(a);
        if (cur == null || m[a] === cur) continue;
        const out = tr(cur); m[a] = out;
        if (out !== cur) el.setAttribute(a, out);
      }
      if (el.nodeName === 'A' && LEGAL.lang) { const h = el.getAttribute('href') || ''; const r = legalHref(h, LEGAL.lang); if (r !== h) el.setAttribute('href', r); }
    }
    function walk(node) {
      if (node.nodeType === 3) return text(node);
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      if (node.nodeType === 1) { if (skip(node)) return; attrs(node); }
      const tw = d.createTreeWalker(node, 5 /* ELEMENT | TEXT */);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.nodeType === 3) text(n); else attrs(n); }
    }
    walk(root);
    const mo = new w.MutationObserver(list => {
      for (const r of list) {
        if (r.type === 'characterData') text(r.target);
        else if (r.type === 'attributes') attrs(r.target);
        else for (const n of r.addedNodes) walk(n);
      }
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat('href') });
    return mo;
  }

  // Privātuma politika / noteikumi — tās pašas lapas tulkojums (privacy-en.html), latviešu versija ir noteicošā
  const LEGAL = { lang: null };
  function legalHref(h, lang) {
    if (lang === 'lv') return h;
    return h.replace(/^(\.\/)?(privacy|terms)\.html(?=$|[?#])/, (m, p, n) => (p || '') + n + '-' + lang + '.html');
  }

  // --- Valodas izvēles logs (pirmā atvēršana) ---
  const NAMES = { lv: 'Latviešu', en: 'English', ru: 'Русский' };
  function czLangDialog(cur, onPick) {
    const box = d.createElement('div');
    box.id = 'langGate'; box.className = 'lang-gate'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'langGateTitle'); box.setAttribute('data-noi18n', '');
    const opts = ['lv', 'en', 'ru'].map(l => `<button type="button" class="lang-opt" data-lang="${l}" aria-pressed="${l === cur}"${l === cur ? ' autofocus' : ''}><span lang="${l}">${NAMES[l]}</span></button>`).join('');
    box.innerHTML = `<div class="lang-card"><div class="lang-globe" aria-hidden="true">🌐</div>
      <h2 id="langGateTitle"><span lang="lv">Izvēlies valodu</span> · <span lang="en">Choose language</span> · <span lang="ru">Выберите язык</span></h2>
      <div class="lang-opts">${opts}</div>
      <button type="button" class="lang-other" data-lang="other"><span lang="en">Other language</span> · <span lang="lv">Cita valoda</span> · <span lang="ru">Другой язык</span></button>
      <p class="lang-hint" hidden><span lang="en">The app opens in English — use your browser's “Translate” to read it in your language.</span></p>
      <p class="lang-note"><span lang="lv">Valodu var mainīt iestatījumos.</span> <span lang="en">You can change it in Settings.</span></p></div>`;
    box.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-lang]'); if (!b) return;
      const l = b.getAttribute('data-lang');
      if (l === 'other') {
        box.querySelector('.lang-hint').hidden = false;
        b.disabled = true;
        w.setTimeout(() => onPick('en', box), 2600);
        return;
      }
      onPick(l, box);
    });
    return box;
  }

  function czLangSet(lang, reload = true) {
    if (!LANGS.includes(lang)) return;
    set(KEY, lang);
    if (reload) {
      const u = new URL(w.location.href); u.searchParams.delete('lang');
      if (lang === CZ.lang) return;
      w.location.replace(u.pathname + u.search + u.hash);
    }
  }

  // --- Palaišana ---
  const CZ = { lang: 'lv', chosen: true, tr: s => s, ready: false };
  function start() {
    const p = czLangPick(w.location.search, get(KEY), w.navigator.languages || [w.navigator.language]);
    if (p.fromUrl) set(KEY, p.lang);
    CZ.lang = p.lang; CZ.chosen = p.chosen; LEGAL.lang = p.lang;
    d.documentElement.lang = p.lang;
    const show = () => { d.documentElement.style.visibility = ''; };
    const run = () => {
      const dict = ((w.CZ_I18N || {})[p.lang]) || null;
      if (dict) { const m = czI18nMake(dict); CZ.tr = m.tr; }
      CZ.ready = true;
      czI18nDom(d.documentElement, CZ.tr);
      show();
    };
    if (p.lang === 'lv') CZ.ready = true;
    else {
      // Vārdnīca: <script type="text/x-cz-i18n" data-lang="en" src="i18n-en.js?v=…"> (index.html — versija no būvēšanas)
      const tag = d.querySelector('script[type="text/x-cz-i18n"][data-lang="' + p.lang + '"]');
      const src = tag ? tag.getAttribute('src') : 'i18n-' + p.lang + '.js';
      d.documentElement.style.visibility = 'hidden';
      const t = w.setTimeout(show, 3000);            // vārdnīca neielādējas → latviski, bet lapa redzama
      const s = d.createElement('script');
      s.src = src;
      s.addEventListener('load', () => { w.clearTimeout(t); run(); });
      s.addEventListener('error', () => { w.clearTimeout(t); CZ.ready = true; show(); });
      d.head.appendChild(s);
    }
    // Pirmā atvēršana — valodas izvēle (redzama virs noteikumu piekrišanas)
    if (!p.chosen) {
      const open = () => {
        if (d.getElementById('langGate')) return;
        const box = czLangDialog(p.lang, (l, el) => { el.remove(); if (l === p.lang) set(KEY, l); else czLangSet(l); });
        d.body.appendChild(box);
        // Fokuss paliek logā (arī ja piekrišanas logs zem tā mēģina to paņemt); Tab riņķo pa pogām
        const first = () => box.querySelector('[aria-pressed="true"]') || box.querySelector('button');
        const trap = ev => {
          if (!box.isConnected) { d.removeEventListener('focusin', trap, true); return; }
          if (!box.contains(ev.target)) { const f = first(); if (f) f.focus(); }
        };
        d.addEventListener('focusin', trap, true);
        box.addEventListener('keydown', ev => {
          if (ev.key !== 'Tab') return;
          const bs = [...box.querySelectorAll('button:not([disabled])')];
          const i = bs.indexOf(d.activeElement);
          if (ev.shiftKey && i <= 0) { ev.preventDefault(); bs[bs.length - 1].focus(); }
          else if (!ev.shiftKey && i === bs.length - 1) { ev.preventDefault(); bs[0].focus(); }
        });
        const f = first(); if (f) f.focus();
      };
      if (d.body) open(); else d.addEventListener('DOMContentLoaded', open);
    }
    // Iestatījumu izvēlne (index.html #langSelect)
    d.addEventListener('change', ev => { if (ev.target && ev.target.id === 'langSelect') czLangSet(ev.target.value); });
    d.addEventListener('DOMContentLoaded', () => { const sel = d.getElementById('langSelect'); if (sel) sel.value = p.lang; });
    // Pārlūka logi (apstiprinājums) — tas pats tulkojums
    for (const f of ['alert', 'confirm', 'prompt']) {
      const orig = w[f]; if (typeof orig !== 'function') continue;
      w[f] = function (m, ...r) { return orig.call(w, CZ.tr(String(m == null ? '' : m)), ...r); };
    }
  }

  // Kodam: czT('latviešu teksts') — tulkojums (piem. paziņojumiem ārpus lapas); czLocale() — skaitļu / datumu formāts
  w.czT = s => CZ.tr(s);
  w.czLang = () => CZ.lang;
  w.czLocale = () => LOCALE[CZ.lang] || 'lv-LV';
  w.czLangSet = czLangSet;
  w.CZ_I18N_API = { czLangGuess, czLangPick, czI18nMake, czI18nDom, czLangDialog, legalHref, LANGS };
  if (!w.CZ_I18N_TEST) start();
})(typeof window !== 'undefined' ? window : globalThis);
