#!/usr/bin/env node
// Ceļa Zīmes — navigācijas balss ierakstu ģenerēšana ar Google Cloud Text-to-Speech (Chirp 3 HD, lv-LV).
//
// Palaiž TAVĀ datorā (API atslēga paliek tikai tur, lapā tā nenonāk). Vajag Node.js 18+.
//
//   node tools/gen-voice.mjs voices                       — kuras latviešu balsis ir pieejamas
//   node tools/gen-voice.mjs samples                      — paraugi salīdzināšanai (voice/samples/index.html)
//   node tools/gen-voice.mjs samples --voices Charon,Kore — tikai dažas balsis
//   node tools/gen-voice.mjs build --voice Charon         — visas navigācijas frāzes → voice/lv/
//   node tools/gen-voice.mjs build --voice Charon --rate 0.95
//
// Pieslēgšanās (viens no):
//   GOOGLE_TTS_API_KEY=...            (API atslēga, ierobežota tikai uz Text-to-Speech API)
//   vai gcloud CLI:  gcloud auth login  (skripts paņem žetonu ar "gcloud auth print-access-token")
//                     un GOOGLE_CLOUD_PROJECT=projekta-id
//
// "build" ir pakāpenisks: jau ģenerētos failus (tā pati balss, ātrums, teksts) neģenerē vēlreiz,
// vecos (vairs nevajadzīgos) failus izdzēš. Rezultāts: voice/lv/*.mp3 + voice/lv/manifest.json.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://texttospeech.googleapis.com/v1';
const LANG = 'lv-LV';

// ---------- Frāzes no aplikācijas koda (tās pašas, ko navigācija runā) ----------
function loadApp() {
  const ctx = { console };
  vm.createContext(ctx);
  for (const f of ['voice.js', 'alerts.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
export function phraseList() {
  const app = loadApp();
  return vm.runInContext('voicePhraseLibrary(Object.values(ALERT_TYPES).map(a => a.label))', app);
}
export function clipKey(text) {
  return loadApp().voiceClipKey(text);
}
// Kā frāzi nosūtīt sintēzei: ar lielo burtu; teikuma sākuma daļām — komats (balss "turpina"),
// darbībām — punkts (dabiska teikuma beigu intonācija).
export function ttsText(phrase) {
  const s = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  if (/^(Pēc |Uzmanību)/.test(s)) return s + ',';
  return s + '.';
}

// ---------- Google TTS ----------
let auth = null;
function getAuth() {
  if (auth) return auth;
  if (process.env.GOOGLE_TTS_API_KEY) return (auth = { query: '?key=' + encodeURIComponent(process.env.GOOGLE_TTS_API_KEY), headers: {} });
  let token;
  try { token = execSync('gcloud auth print-access-token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { throw new Error('Nav pieslēgšanās: iestati GOOGLE_TTS_API_KEY vai palaid "gcloud auth login".'); }
  let project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) try { project = execSync('gcloud config get-value project', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* */ }
  const headers = { Authorization: 'Bearer ' + token };
  if (project) headers['x-goog-user-project'] = project;
  return (auth = { query: '', headers });
}
async function api(pathname, body) {
  const a = getAuth();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + pathname + a.query, {
      method: body ? 'POST' : 'GET',
      headers: { ...a.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const msg = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    throw new Error(`Google TTS ${res.status}: ${msg.slice(0, 400)}`);
  }
}
function voiceName(v) { return v.includes('-') ? v : `${LANG}-Chirp3-HD-${v}`; }
async function synth(text, voice, rate) {
  const j = await api('/text:synthesize', {
    input: { text },
    voice: { languageCode: LANG, name: voiceName(voice) },
    audioConfig: { audioEncoding: 'MP3', speakingRate: rate, sampleRateHertz: 24000 },
  });
  if (!j.audioContent) throw new Error('Tukša atbilde: ' + text);
  return Buffer.from(j.audioContent, 'base64');
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ---------- Komandas ----------
export async function cmdVoices() {
  const j = await api('/voices?languageCode=' + LANG);
  const list = (j.voices || []).filter(v => v.languageCodes.includes(LANG));
  if (!list.length) { console.log('Latviešu (lv-LV) balsis netika atrastas šim kontam/reģionam.'); return []; }
  for (const v of list) console.log(`${v.name.padEnd(36)} ${v.ssmlGender}`);
  return list;
}

const SAMPLE_SENTENCES = [
  'Pēc simt piecdesmit metriem pagriezies pa kreisi.',
  'Pēc divsimt piecdesmit metriem aplī izbrauc pa otro izbrauktuvi.',
  'Pēc piecsimt metriem nobrauc no šosejas pa labi.',
  'Pēc simt metriem pagriezies pa labi, tad pa kreisi.',
  'Uzmanību, ātruma kamera, pēc trīssimt metriem.',
  'Maršruts pārrēķināts.',
  'Pēc simt metriem galamērķis būs pa labi.',
  'Esi ieradies galamērķī.',
];
export async function cmdSamples(opts) {
  let voices = opts.voices ? opts.voices.split(',').map(s => s.trim()).filter(Boolean) : null;
  if (!voices) voices = (await cmdVoices()).map(v => v.name).filter(n => /Chirp3-HD/.test(n));
  const rate = +opts.rate || 1.0;
  const dir = path.join(ROOT, 'voice', 'samples');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  let chars = 0;
  await pool(voices, 3, async v => {
    const files = [];
    for (let i = 0; i < SAMPLE_SENTENCES.length; i++) {
      const f = `${voiceName(v).replace(/[^A-Za-z0-9-]/g, '')}-${i + 1}.mp3`;
      fs.writeFileSync(path.join(dir, f), await synth(SAMPLE_SENTENCES[i], v, rate));
      chars += SAMPLE_SENTENCES[i].length; files.push(f);
    }
    rows.push({ v: voiceName(v), files });
    console.log('✓', voiceName(v));
  });
  rows.sort((a, b) => a.v.localeCompare(b.v));
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Balsu salīdzināšana</title>
<style>body{font:15px system-ui;margin:16px;background:#fff;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px;vertical-align:top}
th{background:#f3f4f6;text-align:left}audio{width:150px}select{font:inherit}</style>
<h1>Navigācijas balss — salīdzināšana (lv-LV, ātrums ${rate})</h1>
<p>Klausies katru rindu. Vērtē 1–5: saprotamība, izruna (garumzīmes, mīkstinājumi), dabiskums, temps. Uzvarētāja nosaukumu ieliec komandā <code>build --voice …</code>.</p>
<table><tr><th>Balss</th>${SAMPLE_SENTENCES.map(s => `<th>${esc(s)}</th>`).join('')}<th>Vērtējums</th></tr>
${rows.map(r => `<tr><td><b>${esc(r.v)}</b></td>${r.files.map(f => `<td><audio controls preload="none" src="${f}"></audio></td>`).join('')}<td><select><option></option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></td></tr>`).join('\n')}
</table>`);
  console.log(`\nGatavs: ${path.join(dir, 'index.html')}  (${chars} rakstzīmes)`);
}

export async function cmdBuild(opts) {
  if (!opts.voice) throw new Error('Norādi balsi: build --voice Charon (saraksts: node tools/gen-voice.mjs voices)');
  const voice = voiceName(opts.voice), rate = +opts.rate || 1.0;
  const dir = path.join(ROOT, 'voice', 'lv');
  fs.mkdirSync(dir, { recursive: true });
  const phrases = phraseList();
  const app = loadApp();
  const clips = {}, jobs = [];
  for (const p of phrases) {
    const key = app.voiceClipKey(p);
    const text = ttsText(p);
    const file = crypto.createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 12) + '.mp3';
    clips[key] = file;
    if (!fs.existsSync(path.join(dir, file))) jobs.push({ text, file });
  }
  let done = 0, chars = 0;
  await pool(jobs, 4, async j => {
    fs.writeFileSync(path.join(dir, j.file), await synth(j.text, voice, rate));
    chars += j.text.length;
    process.stdout.write(`\r${++done}/${jobs.length}  ${j.text.padEnd(50)}`);
  });
  // Vecie faili, kas vairs nav vajadzīgi
  const keep = new Set(Object.values(clips));
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.mp3') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
  const short = voice.replace(/^lv-LV-Chirp3-HD-/i, '');
  const manifest = { label: opts.label || `Google ${short}`, voice, rate, engine: 'google-chirp3-hd', generated: new Date().toISOString(), count: Object.keys(clips).length, clips };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const bytes = [...keep].reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  console.log(`\nGatavs: ${manifest.count} frāzes, ${(bytes / 1024 / 1024).toFixed(1)} MB, jaunas ${jobs.length} (${chars} rakstzīmes) → ${dir}`);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else o._.push(argv[i]);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  const run = { voices: cmdVoices, samples: cmdSamples, build: cmdBuild, phrases: async () => { for (const p of phraseList()) console.log(ttsText(p)); } }[cmd];
  if (!run) { console.log('Komandas: voices | samples [--voices A,B] [--rate 1.0] | build --voice NAME [--rate 1.0] [--label "…"] | phrases'); process.exit(1); }
  run(opts).catch(e => { console.error('\n' + e.message); process.exit(1); });
}
