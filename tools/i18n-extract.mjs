// Ceļa Zīmes — lietotnes tekstu saraksts tulkošanai (audits 2, B20).
//
// Lietošana:  node tools/i18n-extract.mjs            → izdrukā visus latviešu tekstus (pa vienam rindā, JSON virkne)
//             node tools/i18n-extract.mjs --missing  → tikai tos, kam nav tulkojuma i18n-en.js / i18n-ru.js
// tests/run.js (B20) pārbauda: katram tekstam ir tulkojums angļu un krievu valodā vai tas ir i18n-skip.json.
//
// Teksts = tas, ko lietotājs var redzēt: virkņu literāļi JS failos (bez komentāriem), index.html teksti un atribūti
// (title, aria-label, placeholder, alt), servera kļūdu ziņojumi (SQL raise exception, Edge Functions „error”).
// Virknes ar HTML sadala tāpat kā pārlūks — pa teksta gabaliem starp tagiem; ${…} → {*} (vieta mainīgajam).
// Saglabā tikai gabalus ar burtiem, kas izskatās pēc latviešu teksta (sk. czI18nLooksLv). admin.* netulko (tikai īpašniekam).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_JS = new Set(['admin.js', 'i18n.js', 'i18n-en.js', 'i18n-ru.js', 'sw.js', 'guard.js', 'redirect.js', 'skins-art.js']);

// --- JS virkņu literāļi (bez komentāriem un regulārajām izteiksmēm) ---
export function czI18nJsStrings(src) {
  const out = [];
  let i = 0, prev = '';                       // prev — pēdējais nozīmīgais simbols (regex vai dalīšana?)
  const n = src.length;
  const regexOk = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of|new|delete|void|throw|else|do)$/.test(prev);
  function readTemplate() {                   // i — pēc atverošā `
    let s = '', depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { const e = src[i + 1]; s += e === 'n' ? '\n' : e === 'u' ? String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)) : e; i += e === 'u' ? 6 : 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') {
        // ${ … } — iekšā var būt virknes un citi `…` (izvelk arī tos)
        i += 2; depth = 1; s += '{*}';
        const inner = [];
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '{') { depth++; i++; continue; }
          if (d === '}') { depth--; i++; continue; }
          if (d === '\'' || d === '"') { inner.push(readQuoted(d)); continue; }
          if (d === '`') { i++; inner.push(readTemplate()); continue; }
          i++;
        }
        out.push(...inner);
        continue;
      }
      s += c; i++;
    }
    return s;
  }
  function readQuoted(q) {                    // i — uz pēdiņas
    i++; let s = '';
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { const e = src[i + 1]; s += e === 'n' ? '\n' : e === 'u' ? String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)) : e; i += e === 'u' ? 6 : 2; continue; }
      if (src[i] === '\n') break;
      s += src[i++];
    }
    i++;
    return s;
  }
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === '\'' || c === '"') {
      // 'teksts: ' + x → arī „teksts: {*}” (pārlūkā tas ir viens teksta gabals); x + ' teksts' → „{*} teksts”
      const before = prev === '+';
      const str = readQuoted(c);
      let j = i; while (j < n && /[ \t]/.test(src[j])) j++;
      const after = src[j] === '+' && src[j + 1] !== '+' && src[j + 1] !== '=';
      out.push(str);
      if ((before || after) && /[A-Za-zĀ-ž]{2}/.test(str)) out.push((before ? '{*}' : '') + str + (after ? '{*}' : ''));
      prev = 'x'; continue;
    }
    if (c === '`') { i++; out.push(readTemplate()); prev = 'x'; continue; }
    if (c === '/' && regexOk()) {             // regulārā izteiksme — izlaiž
      i++; let cls = false;
      while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
      i++; while (/[a-z]/.test(src[i] || '')) i++;
      prev = 'x'; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) { let w = ''; while (i < n && /[\w$]/.test(src[i])) w += src[i++]; prev = w; continue; }
    prev = c; i++;
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»' };
function unent(s) { return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (a, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? a)); }

// Teksta gabali no HTML (vai virknes ar HTML): teksts starp tagiem un tulkojamie atribūti
export function czI18nHtmlParts(html) {
  const parts = [];
  const h = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const m of h.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const a of m[0].matchAll(/\s(title|aria-label|placeholder|alt|data-i18n-tip)="([^"]*)"/g)) parts.push(unent(a[2]));
  }
  for (const t of h.split(/<[^>]*>/)) parts.push(unent(t));
  return parts;
}

// Vai teksts izskatās pēc latviešu valodas teikuma/vārda (nevis koda, CSS, adreses, atslēgas)
export function czI18nLooksLv(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-zĀ-ž]{2}/.test(t.replace(/\{\*\}/g, ''))) return false;
  if (/^(https?:|mailto:|tel:|data:|\.\/|#|\/)/.test(t)) return false;
  if (/[āčēģīķļņšūžĀČĒĢĪĶĻŅŠŪŽ„”]/.test(t)) return true;
  if (/^[a-z0-9_.:#\-/[\]=*()>+~,"' ]+$/.test(t) && !/^[a-z]+ [a-z]+ [a-z]+/.test(t)) return false;   // CSS klases, selektori, atslēgas
  if (/^[A-Z0-9_]+$/.test(t) || /^[a-z][a-zA-Z0-9]*$/.test(t)) return false;                              // KONSTANTES, camelCase
  if (/[{};]|=>|\(\)/.test(t.replace(/\{\*\}/g, ''))) return false;
  return /^[A-ZĀ-Ž]/.test(t) || / /.test(t);
}

export function czI18nNorm(s) { return s.replace(/\s+/g, ' ').trim(); }   // tāpat kā i18n.js (arī NBSP → atstarpe)

function addParts(set, src, raw) {
  for (const p of (/[<>]/.test(raw) ? czI18nHtmlParts(raw) : [raw])) {
    const t = czI18nNorm(p);
    if (t && czI18nLooksLv(t) && !src.skip.has(t)) set.add(t);
  }
}

export function czI18nSources(root = ROOT) {
  const files = fs.readdirSync(root).filter(f => f.endsWith('.js') && !SKIP_JS.has(f) && !f.startsWith('vite')).sort();
  const fn = path.join(root, 'supabase', 'functions');
  const ts = fs.existsSync(fn) ? fs.readdirSync(fn).filter(d => fs.existsSync(path.join(fn, d, 'index.ts'))).map(d => path.join('supabase', 'functions', d, 'index.ts')) : [];
  const sql = fs.readdirSync(path.join(root, 'supabase')).filter(f => f.endsWith('.sql')).map(f => path.join('supabase', f));
  return { js: files, ts, sql, html: ['index.html'] };
}

export function czI18nExtract(root = ROOT, { skip = true } = {}) {
  const skipF = path.join(root, 'i18n-skip.json');
  const src = { skip: new Set(skip && fs.existsSync(skipF) ? JSON.parse(fs.readFileSync(skipF, 'utf8')) : []) };
  const files = czI18nSources(root);
  const set = new Set();
  for (const f of [...files.js, ...files.ts]) for (const s of czI18nJsStrings(fs.readFileSync(path.join(root, f), 'utf8'))) addParts(set, src, s);
  for (const f of files.sql) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/raise exception '((?:[^']|'')*)'/g)) {
      const t = m[1].replace(/''/g, '\'').replace(/%/g, '{*}');
      if (!/supabase\/|ORDER\.txt|migrācij/.test(t)) addParts(set, src, t);
    }
  }
  for (const f of files.html) for (const p of czI18nHtmlParts(fs.readFileSync(path.join(root, f), 'utf8'))) addParts(set, src, p);
  return [...set].sort((a, b) => a.localeCompare(b, 'lv'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = czI18nExtract();
  let list = all;
  if (process.argv.includes('--missing')) {
    const dict = l => { const f = path.join(ROOT, 'i18n-' + l + '.js'); if (!fs.existsSync(f)) return {}; const w = {}; new Function('window', fs.readFileSync(f, 'utf8'))(w); return (w.CZ_I18N || {})[l] || {}; };
    const en = dict('en'), ru = dict('ru');
    list = all.filter(s => !(s in en) || !(s in ru));
  }
  for (const s of list) console.log(JSON.stringify(s));
  console.error(list.length + ' / ' + all.length);
}
