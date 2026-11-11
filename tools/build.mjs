// Ceļa Zīmes — vietnes būvēšana izvietošanai (audits 2, B15). Mainītos failus NEIERAKSTA repozitorijā — tikai kopijā.
//
// Lietošana (GitHub Actions, darbs „Kartes dūmu tests”):
//   git archive HEAD | tar -x -C <mape>     # tīra kopija
//   node tools/build.mjs <mape> --minify     # --minify vajag esbuild (npm install --no-save esbuild@…)
// Bez --minify — tikai versijas pēc satura (lokāli, bez atkarībām).
//
// Ko dara:
//   1) --minify: katru lapās (*.html) ar ?v= norādīto pašu .js / .css saspiež ar esbuild (bez apvienošanas — katrs fails
//      paliek atsevišķs skripts, tāpēc viena faila kļūda neaptur citus; globālie nosaukumi netiek pārdēvēti — pārbaude zemāk;
//      sintakse netiek pārveidota). vendor/ (MapLibre — jau saspiests) un sw.js netiek aiztikti.
//   2) Versijas pēc satura: katrā lapā ?v=… → ?v=<sha256 pirmās 10 zīmes>. Ar roku mainīt ?v= vairs nav obligāti —
//      jebkura izmaiņa failā dod jaunu adresi (pārlūka un sw.js kešs to ielādē no jauna).
//   3) Pārbaudes (kļūda → build neizdodas → vietne netiek izvietota): visi norādītie faili eksistē; saspiestais skripts ir
//      derīga sintakse; visi faila augšējā līmeņa nosaukumi (function/const/let/var/class) saspiestajā failā joprojām ir.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REF = /(\s(?:src|href)=")([^"?#:]+\.(?:js|mjs|css))\?v=[0-9a-z.]+(")/g;

export function czBuildRefs(html) {
  const out = new Set();
  for (const m of html.matchAll(REF)) out.add(m[2].replace(/^\.\//, ''));
  return [...out];
}
export function czBuildHash(buf) { return createHash('sha256').update(buf).digest('hex').slice(0, 10); }
export function czBuildRewrite(html, hashes) {
  return html.replace(REF, (all, a, p, b) => {
    const h = hashes.get(p.replace(/^\.\//, ''));
    if (!h) throw new Error('nav jaucējvērtības: ' + p);
    return a + p + '?v=' + h + b;
  });
}
// Augšējā līmeņa nosaukumi (rindas sākumā) — tos lieto citi skripti, tāpēc saspiežot tie nedrīkst pazust
export function czBuildTopNames(src) {
  const names = new Set();
  // Viss fails vienā (function () { … })(); bez atkāpes (piem. ģenerētais skins-art.js) — augšējā līmeņa nosaukumu nav
  const code = src.split('\n').filter(l => l.trim() && !/^\s*\/\//.test(l));
  if (code.length && /^\((?:function\s*\(\)|\(\)\s*=>)\s*\{\s*$/.test(code[0]) && /^\}\)\(\);?\s*$/.test(code[code.length - 1])) return [];
  for (const m of src.matchAll(/^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm)) names.add(m[1] || m[2]);
  return [...names];
}
export function czBuildCheckNames(src, out) {
  return czBuildTopNames(src).filter(n => !new RegExp('(^|[^\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])').test(out));
}

export async function czBuild(dir, { minify = false, log = console.log, esbuild: eb = null } = {}) {
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  const files = new Set();
  for (const p of pages) for (const f of czBuildRefs(fs.readFileSync(path.join(dir, p), 'utf8'))) files.add(f);
  let esbuild = null;
  if (minify) esbuild = eb || await import('esbuild');                 // eb — testiem (tests/run.js)
  const hashes = new Map();
  let before = 0, after = 0;
  for (const f of [...files].sort()) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) throw new Error('trūkst faila: ' + f);
    let src = fs.readFileSync(fp, 'utf8');
    before += Buffer.byteLength(src);
    if (esbuild && !f.startsWith('vendor/') && f !== 'sw.js') {
      const css = f.endsWith('.css');
      const r = await esbuild.transform(src, { loader: css ? 'css' : 'js', minify: true, charset: 'utf8', legalComments: 'none' });
      let out = r.code;
      if (!css) {
        const lost = czBuildCheckNames(src, out);
        if (lost.length) throw new Error(f + ': saspiežot pazuda augšējā līmeņa nosaukumi: ' + lost.join(', '));
        // Sintakses pārbaude klasiskajiem skriptiem (ES moduļus — pēc oriģināla: saspiestajā ir „import*as …”)
        if (!/^\s*(import|export)\b/m.test(src)) new vm.Script(out, { filename: f });
      }
      fs.writeFileSync(fp, out);
      src = out;
    }
    after += Buffer.byteLength(src);
    hashes.set(f, czBuildHash(Buffer.from(src)));
  }
  for (const p of pages) {
    const fp = path.join(dir, p);
    fs.writeFileSync(fp, czBuildRewrite(fs.readFileSync(fp, 'utf8'), hashes));
  }
  log(`Būvēts: ${pages.length} lapas, ${files.size} faili, ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB` + (minify ? ' (saspiests)' : ''));
  return { pages, files: [...files], hashes, before, after };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('Lietošana: node tools/build.mjs <mape> [--minify]'); process.exit(2); }
  czBuild(dir, { minify: args.includes('--minify') }).catch(e => { console.error('BŪVĒŠANA NEIZDEVĀS: ' + (e && e.message || e)); process.exit(1); });
}
