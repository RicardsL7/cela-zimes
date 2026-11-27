// Ceļa Zīmes — koda pārbaude ar TypeScript (B16, audits 2). Nekas netiek būvēts vai mainīts — tikai pārbaude.
//
// Kāpēc TypeScript, nevis tikai ESLint: lietotnes ~40 skripti ir klasiski skripti ar VIENU kopīgu globālo tvērumu
// (funkcija vienā failā, izsaukums citā). Rīks katrai lapai (index.html, admin.html) saliek tās skriptus tieši lapas
// secībā vienā pagaidu failā un palaiž `tsc --checkJs` — tā TypeScript redz to pašu, ko pārlūks, un atrod:
//   KĻŪDA (CI neizdodas):  nedefinēts nosaukums (TS2304, TS2552) — piem. pārrakstīts vai izdzēsts funkcijas nosaukums;
//                          divreiz deklarēts globālais nosaukums (TS2451, TS2300, TS2393) — pārlūkā SyntaxError visam failam;
//                          lietots pirms deklarācijas augšējā līmenī (TS2448, TS2449) — pārlūkā ReferenceError ielādē;
//                          divas vienādas atslēgas objektā (TS1117); nesasniedzams kods (TS7027);
//                          switch bez break (TS7029); sintakses kļūdas (TS1xxx).
//   BRĪDINĀJUMS (rāda):    neizmantots nosaukums (TS6133).
//   Pārējo (tipu precizitāte DOM elementiem u.c.) neskaita — kods nav rakstīts ar tipiem.
// sw.js (service worker) — atsevišķi ar webworker bibliotēku. Globālie nosaukumi no ES moduļa / IIFE — tools/check-js.d.ts.
//
// Lietošana: node tools/check-js.mjs      (vajag `tsc`: npm install --no-save typescript@<versija> vai globāli; TSC=ceļš)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CZ_CHECK_FAIL = new Set(['TS2304', 'TS2552', 'TS2451', 'TS2300', 'TS2393', 'TS2448', 'TS2449', 'TS1117', 'TS7027', 'TS7029']);
export const CZ_CHECK_WARN = new Set(['TS6133']);
const PAGES = ['index.html', 'admin.html'];

// Lapas klasiskie skripti secībā (defer, parastie un vēlās ielādes; ES moduļi un ārējie — ne)
export function czCheckScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)\ssrc="([^"?#]+\.js)(?:\?[^"]*)?"[^>]*>/g)) {
    if (/type="module"/.test(m[1]) || /^(https?:)?\/\//.test(m[2])) continue;
    out.push(m[2].replace(/^\.\//, ''));
  }
  return out;
}

// Saliek failus vienā; atgriež tekstu un rindu karti (lai kļūdu var parādīt pēc īstā faila un rindas)
export function czCheckBundle(files, read) {
  const parts = [], map = [];
  let line = 1;
  for (const f of files) {
    const src = read(f).replace(/\r\n/g, '\n').replace(/\bmodule\.exports\b/g, 'globalThis.__czExports');
    const head = `// ==== ${f}`;
    parts.push(head, src);
    map.push({ file: f, start: line + 1 });
    line += 1 + src.split('\n').length;
  }
  return { text: parts.join('\n') + '\n', map };
}
export function czCheckLocate(map, n) {
  let cur = null;
  for (const m of map) if (m.start <= n) cur = m;
  return cur ? { file: cur.file, line: n - cur.start + 1 } : { file: '?', line: n };
}
export function czCheckParse(out, map, bundleName) {
  const res = [];
  const re = new RegExp('^' + bundleName.replace(/[.\\]/g, '\\$&') + '\\((\\d+),(\\d+)\\): error (TS\\d+): (.*)$', 'gm');
  for (const m of out.matchAll(re)) {
    const loc = czCheckLocate(map, Number(m[1]));
    res.push({ ...loc, col: Number(m[2]), code: m[3], msg: m[4] });
  }
  return res;
}

export function czCheckGuarded(line, name) {
  return new RegExp('typeof ' + name.replace(/\$/g, '\\$') + "\\s*(!==?|===?)\\s*'(undefined|function|object)'").test(line);
}

function tscBin() {
  if (process.env.TSC) return [process.env.TSC];
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  return [fs.existsSync(local) ? local : 'tsc'];
}
function runTsc(dir, files, lib) {
  // tsconfig (nevis komandrindas karodziņi) — vienādi TypeScript 6 un 7
  const cfg = { compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: false, target: 'es2022', lib: lib.split(','),
    skipLibCheck: true, types: [], noUnusedLocals: true, allowUnreachableCode: false, noFallthroughCasesInSwitch: true, pretty: false }, files };
  const name = 'tsconfig.' + files[0].replace(/\W/g, '_') + '.json';
  fs.writeFileSync(path.join(dir, name), JSON.stringify(cfg));
  let out;
  try { out = execFileSync(tscBin()[0], ['-p', name], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }); }
  catch (e) {
    if (e.stdout == null && e.stderr == null) throw new Error('tsc nav atrodams (' + e.message + ')');
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  // Kļūda ārpus pārbaudāmajiem failiem (konfigurācija, tsc pats) — pārbaude nav notikusi → neizdodas, nevis „0 kļūdas”
  const other = out.split('\n').filter(l => /error TS\d+/.test(l) && !files.some(f => l.startsWith(f + '(')));
  if (other.length) throw new Error('tsc: ' + other.slice(0, 3).join(' | '));
  return out;
}

export function czCheck({ log = console.log } = {}) {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-check-'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'check-js.d.ts'), path.join(dir, 'globals.d.ts'));
  const all = [];
  try {
    for (const page of PAGES) {
      const files = czCheckScripts(read(page));
      const name = page.replace(/\.html$/, '') + '.bundle.js';
      const b = czCheckBundle(files, read);
      fs.writeFileSync(path.join(dir, name), b.text);
      const out = runTsc(dir, [name, 'globals.d.ts'], 'dom,dom.iterable,es2023');
      for (const e of czCheckParse(out, b.map, name)) all.push({ page, ...e });
      log(`${page}: ${files.length} skripti`);
    }
    // sw.js — service worker (cits globālais objekts)
    const sw = czCheckBundle(['sw.js'], read);
    fs.writeFileSync(path.join(dir, 'sw.bundle.js'), sw.text);
    for (const e of czCheckParse(runTsc(dir, ['sw.bundle.js'], 'webworker,es2023'), sw.map, 'sw.bundle.js')) all.push({ page: 'sw.js', ...e });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Viena un tā pati kļūda vairākās lapās (piem. auth.js) — vienreiz
  const seen = new Set(), uniq = [];
  for (const e of all) { const k = `${e.file}:${e.line}:${e.col}:${e.code}`; if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  // `typeof x !== 'undefined' && x…` — apzināti pārbaudīts nosaukums no citas lapas daļas (piem. auth.js admin.html lapā) — nav kļūda
  const lines = new Map();
  const guarded = e => {
    if (e.code !== 'TS2304' && e.code !== 'TS2552') return false;
    const n = (/Cannot find name '([\w$]+)'/.exec(e.msg) || [])[1];
    if (!n) return false;
    if (!lines.has(e.file)) lines.set(e.file, read(e.file).replace(/\r\n/g, '\n').split('\n'));
    return czCheckGuarded(lines.get(e.file)[e.line - 1] || '', n);
  };
  const isFail = e => (CZ_CHECK_FAIL.has(e.code) || /^TS1\d{3}$/.test(e.code)) && !guarded(e);
  const fails = uniq.filter(isFail), warns = uniq.filter(e => !isFail(e) && CZ_CHECK_WARN.has(e.code));
  for (const e of warns) log(`brīdinājums ${e.file}:${e.line}:${e.col} ${e.code} ${e.msg}`);
  for (const e of fails) log(`KĻŪDA ${e.file}:${e.line}:${e.col} ${e.code} ${e.msg}`);
  log(`Koda pārbaude: ${fails.length} kļūdas, ${warns.length} brīdinājumi, ${uniq.length - fails.length - warns.length} tipu piezīmes (netiek skaitītas)`);
  return { fails, warns, all: uniq };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const r = czCheck(); process.exit(r.fails.length ? 1 : 0); }
  catch (e) { console.error('KODA PĀRBAUDE NEIZDEVĀS: ' + (e && e.message || e)); process.exit(1); }
}
