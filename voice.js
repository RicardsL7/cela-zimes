// ---------- Balss norādes (latviski) ----------
// Teksti un lēmumi "ko un kad teikt" — tīras funkcijas (testējamas);
// runāšana — pārlūka runas sintēze (speechSynthesis) ar latviešu balsi, ja tāda ir.

// ---------- Skaitļi vārdiem (balsij jāsaka "trīssimt", nevis jālasa cipari) ----------
const LV_ONES = ['', 'viens', 'divi', 'trīs', 'četri', 'pieci', 'seši', 'septiņi', 'astoņi', 'deviņi'];
const LV_ONES_F = ['', 'viena', 'divas', 'trīs', 'četras', 'piecas', 'sešas', 'septiņas', 'astoņas', 'deviņas'];
const LV_ONES_DAT = ['', 'vienam', 'diviem', 'trim', 'četriem', 'pieciem', 'sešiem', 'septiņiem', 'astoņiem', 'deviņiem'];
const LV_TEENS = ['desmit', 'vienpadsmit', 'divpadsmit', 'trīspadsmit', 'četrpadsmit', 'piecpadsmit', 'sešpadsmit', 'septiņpadsmit', 'astoņpadsmit', 'deviņpadsmit'];
const LV_TENS = ['', 'desmit', 'divdesmit', 'trīsdesmit', 'četrdesmit', 'piecdesmit', 'sešdesmit', 'septiņdesmit', 'astoņdesmit', 'deviņdesmit'];
const LV_HUND = ['', 'simt', 'divsimt', 'trīssimt', 'četrsimt', 'piecsimt', 'sešsimt', 'septiņsimt', 'astoņsimt', 'deviņsimt'];
// 1..999 vārdiem; ones — vienu forma (vīriešu nominatīvs / sieviešu / datīvs)
function lvNumber(n, ones = LV_ONES) {
  n = Math.round(n);
  if (n <= 0 || n > 999) return String(n);
  const h = Math.floor(n / 100), r = n % 100, w = [];
  if (h) w.push(LV_HUND[h]);
  if (r >= 10 && r < 20) w.push(LV_TEENS[r - 10]);
  else { if (Math.floor(r / 10)) w.push(LV_TENS[Math.floor(r / 10)]); if (r % 10) w.push(ones[r % 10]); }
  return w.join(' ');
}

// "Pēc trīssimt metriem" · "Pēc viena kilometra" · "Pēc pusotra kilometra" · "Pēc diviem kilometriem"
function voiceDistance(m) {
  if (m >= 1750) { const km = Math.round(m / 1000); return `Pēc ${km < 10 ? LV_ONES_DAT[km] : lvNumber(km, LV_ONES_DAT)} kilometriem`; }
  if (m >= 1250) return 'Pēc pusotra kilometra';
  if (m >= 950) return 'Pēc viena kilometra';
  const r = m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  return `Pēc ${lvNumber(r)} metriem`;
}

// Manevrs runai: tas pats teksts kā ekrānā, tikai ielas nosaukums pēc pauzes (komata).
function maneuverTextForVoice(step) {
  const txt = typeof maneuverText === 'function' ? maneuverText(step) : '';
  return txt.replace(/: /, ', ');
}
function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

// Vai manevrs ir tāds, par ko vērts brīdināt (ne "turpini taisni, iela maina nosaukumu").
function voiceWorthy(step) {
  const m = (step && step.maneuver) || {};
  if (!m.type) return false;                       // trūkst datu — labāk klusēt
  if (m.type === 'new name' || m.type === 'depart' || m.type === 'notification') return false;
  if (m.type === 'exit roundabout' || m.type === 'exit rotary') return false;   // izbrauktuvi jau pateica, iebraucot aplī
  if ((m.type === 'continue' || m.type === 'fork' || m.type === 'merge') && (!m.modifier || m.modifier === 'straight')) return false;
  return true;
}

// ---------- Frāžu bibliotēka ----------
// Īsi, vienmēr vienādi teikumi uz "tu". Bez ielu nosaukumiem — tāpēc visu, ko balss jebkad
// var pateikt, var ierakstīt iepriekš (voicePhraseLibrary) un atskaņot bez aizkaves.
const LV_ORD_ACC = ['', 'pirmo', 'otro', 'trešo', 'ceturto', 'piekto', 'sesto', 'septīto', 'astoto'];
function voiceSide(mod) { return /left/.test(mod || '') ? 'pa kreisi' : /right/.test(mod || '') ? 'pa labi' : ''; }
// Īss manevrs runai: "pagriezies pa labi", "aplī izbrauc pa otro izbrauktuvi".
function voiceManeuverShort(step) {
  const m = (step && step.maneuver) || {}, type = m.type, mod = m.modifier || '';
  const side = voiceSide(mod);
  switch (type) {
    case 'arrive': return side ? 'galamērķis būs ' + side : 'galamērķis';
    case 'roundabout': case 'rotary': case 'roundabout turn':
      if (type === 'roundabout turn' && side) return 'aplī pagriezies ' + side;
      return m.exit && LV_ORD_ACC[m.exit] ? `aplī izbrauc pa ${LV_ORD_ACC[m.exit]} izbrauktuvi` : 'iebrauc aplī';
    case 'exit roundabout': case 'exit rotary': return 'izbrauc no apļa';
    case 'merge': return 'iekļaujies satiksmē';
    case 'on ramp': return 'iebrauc uzbrauktuvē' + (side ? ' ' + side : '');
    case 'off ramp': return 'nobrauc no šosejas' + (side ? ' ' + side : '');
    case 'fork': return side ? 'turies ' + side : 'turpini taisni';
    case 'end of road': return side ? 'ceļa galā pagriezies ' + side : 'ceļa galā pagriezies';
  }
  if (mod === 'uturn') return 'apgriezies';
  if (!side) return 'turpini taisni';
  if (mod.startsWith('slight')) return 'nogriezies ' + side;
  if (mod.startsWith('sharp')) return 'strauji pagriezies ' + side;
  return 'pagriezies ' + side;
}
// Ķēdē: "…, tad pa labi" (vienkāršam pagriezienam tikai virziens).
function voiceThen(step) {
  const t = voiceManeuverShort(step);
  return 'tad ' + (/^pagriezies /.test(t) ? t.replace(/^pagriezies /, '') : t);
}

// Kad runāt: vienreiz par katru manevru, šajā attālumā (atkarībā no ātruma).
function voiceThresholds(speedKmh) {
  const v = speedKmh || 0;
  return { near: v >= 75 ? 500 : v >= 45 ? 250 : 150 };
}

// Viens īss teikums par manevru: "Pēc simt piecdesmit metriem pagriezies pa kreisi".
// Ja nākamais manevrs seko tūlīt (< 120 m), to pievieno tajā pašā teikumā ("…, tad pa labi")
// un vēlāk par to vairs nerunā. said — Set ar jau pateiktajiem manevriem.
// parts — teikuma daļas, katra ir viena ierakstīta frāze (attālums · manevrs · "tad …").
function voiceForManeuver(stepId, step, toNext, speedKmh, said, after = null, gapAfter = Infinity) {
  if (!voiceWorthy(step) || said.has(stepId + ':said')) return null;
  if (!(toNext >= 0) || toNext > voiceThresholds(speedKmh).near + 20) return null;
  said.add(stepId + ':said');
  const arrive = step.maneuver && step.maneuver.type === 'arrive';
  if (arrive) {
    said.add('arrived');
    if (toNext < 40) return voiceItem(stepId + ':said', ['Esi ieradies galamērķī']);
    return voiceItem(stepId + ':said', [voiceDistance(toNext), voiceManeuverShort(step)]);
  }
  const parts = [voiceManeuverShort(step)];
  if (after && voiceWorthy(after) && gapAfter < 120 && !(after.maneuver && after.maneuver.type === 'arrive')) {
    parts.push(voiceThen(after));
    said.add((stepId + 1) + ':said');
  }
  if (toNext < 40) parts[0] = upperFirst(parts[0]);
  else parts.unshift(voiceDistance(toNext));
  return voiceItem(stepId + ':said', parts);
}
function upperFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
const lowerFirstUp = upperFirst;   // vecais nosaukums (saderībai)
// Teikums no daļām: teksts ekrānam/telefona balsij + daļas ierakstiem.
function voiceItem(key, parts) {
  return { key, parts, text: parts.map((p, i) => !i ? p : /^tad /.test(p) || /^Uzmanību/.test(parts[i - 1]) ? ', ' + lowerFirst(p) : ' ' + p).join('') };
}
function withParts(key, a, b) { return voiceItem(key, [a, b]); }

// Brīdinājumu nosaukumi runai — īsāki un bez "/" (ekrānā paliek pilnie).
const VOICE_ALERT_SPOKEN = {
  'Sastrēgums / lēna satiksme': 'sastrēgums', 'Apledojums / slidens ceļš': 'slidens ceļš',
  'Skolas zona / bērni': 'bērni uz ceļa', 'Ceļu satiksmes negadījums': 'negadījums',
  'Apstājies transportlīdzeklis': 'apstājusies automašīna', 'Satiksmes ierobežojums': 'satiksmes ierobežojums',
};
function voiceAlertHead(label) {
  const s = VOICE_ALERT_SPOKEN[label] || (label ? label.charAt(0).toLowerCase() + label.slice(1) : '');
  return 'Uzmanību, ' + s;
}
// Brīdinājums par notikumu / zīmi priekšā (vienreiz par katru).
function voiceForAlert(key, label, dist, speedKmh, said) {
  const limit = (speedKmh || 0) >= 75 ? 700 : 400;
  if (!label || !(dist >= 0) || dist > limit || dist < 15 || said.has('alert:' + key)) return null;
  said.add('alert:' + key);
  const head = voiceAlertHead(label);
  return voiceItem('alert:' + key, dist < 60 ? [head, 'tūlīt'] : [head, voiceDistance(dist)]);
}

// Citas fiksētas frāzes.
const VOICE_FIXED = ['Esi ieradies galamērķī', 'Maršruts pārrēķināts', 'tūlīt'];

// Visas frāzes, ko balss var pateikt (ierakstiem). alertLabels — ALERT_TYPES nosaukumi.
function voiceManeuverSamples() {
  const out = [];
  const mods = ['left', 'right', 'slight left', 'slight right', 'sharp left', 'sharp right', 'straight', 'uturn', ''];
  for (const type of ['turn', 'continue', 'end of road', 'fork', 'merge', 'on ramp', 'off ramp', 'arrive', 'roundabout turn'])
    for (const modifier of mods) out.push({ maneuver: { type, modifier } });
  for (const type of ['roundabout', 'rotary']) for (let exit = 0; exit <= 8; exit++) out.push({ maneuver: { type, exit: exit || undefined } });
  return out.filter(voiceWorthy);
}
function voicePhraseLibrary(alertLabels = []) {
  const out = new Set([...voiceDistancePhrases(), ...VOICE_FIXED]);
  for (const s of voiceManeuverSamples()) {
    out.add(voiceManeuverShort(s));
    if (s.maneuver.type !== 'arrive') out.add(voiceThen(s));
  }
  for (const l of alertLabels) out.add(voiceAlertHead(l));
  return [...out];
}
// Atslēga ierakstu meklēšanai: reģistrs un pieturzīmes nav svarīgas.
function voiceClipKey(text) {
  return String(text || '').toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- Normalizācija (telefona / Piper balsij, ja teksts satur ciparus vai saīsinājumus) ----------
// Izrunas vārdnīca: vārdi, ko sintezatori bieži izrunā nepareizi → kā tos rakstīt izrunai.
const LV_PRONUNCIATION = { 'apļveida': 'apļ-veida', 'GPS': 'gē pē es', 'km/h': 'kilometri stundā' };
const LV_LETTERS = { A: 'A', P: 'P', V: 'V', E: 'E' };
function voiceNormalize(text) {
  let s = String(text || '');
  for (const [k, v] of Object.entries(LV_PRONUNCIATION)) s = s.split(k).join(v);
  // Ceļu numuri: A1 → "A viens", P120 → "P simt divdesmit", E67 → "E sešdesmit septiņi"
  s = s.replace(/\b([APVE])(\d{1,4})\b/g, (_, l, n) => LV_LETTERS[l] + ' ' + (+n <= 999 ? lvNumber(+n) : n));
  // "200 m" → "divsimt metri"; "3 km" → "trīs kilometri"
  s = s.replace(/\b(\d{1,3})\s?km\b/g, (_, n) => lvNumber(+n) + ' kilometri');
  s = s.replace(/\b(\d{1,3})\s?m\b/g, (_, n) => lvNumber(+n) + ' metri');
  s = s.replace(/\b\d{1,3}\b/g, n => lvNumber(+n));
  return s.replace(/\s+/g, ' ').trim();
}

// "divpadsmit minūtes" · "divdesmit viena minūte" · "viena stunda piecas minūtes"
function voiceDuration(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  const one = n => n % 10 === 1 && n % 100 !== 11;
  const mins = n => lvNumber(n, LV_ONES_F) + (one(n) ? ' minūte' : ' minūtes');
  if (min < 60) return mins(min);
  const h = Math.floor(min / 60), m = min % 60;
  return lvNumber(h, LV_ONES_F) + (one(h) ? ' stunda' : ' stundas') + (m ? ' ' + mins(m) : '');
}

// Visi attālumu teikumi, ko balss var teikt — dabiskā balss tos sagatavo iepriekš.
function voiceDistancePhrases() {
  const out = new Set();
  for (let m = 10; m < 100; m += 10) out.add(voiceDistance(m));
  for (let m = 100; m <= 949; m += 25) out.add(voiceDistance(m));
  for (let km = 1; km <= 10; km++) out.add(voiceDistance(km * 1000));
  out.add(voiceDistance(1500));
  return [...out];
}

// ---------- Runātājs ----------
// Balsu ķēde: 1) ierakstītā Google balss (ja visas teikuma daļas ir ierakstītas),
// 2) dabiskā Piper balss telefonā, 3) telefona iebūvētā balss. Navigācijas kods zina tikai Voice.
class Voice {
  constructor() {
    this.enabled = true;
    this.recorded = null;        // RecordedVoice, ja ieraksti pieejami un izvēlēti
    this.neural = null;          // NeuralVoice, ja dabiskā balss ielādēta
    this.voice = null;
    this.last = null;            // { key, at } — lai to pašu nepasaka divreiz pēc kārtas
    this.ok = typeof speechSynthesis !== 'undefined';
    if (this.ok) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find(v => /^lv(-|_|$)/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', pick);
    }
  }
  get hasLatvian() { return !!this.voice; }
  // Telefoni atļauj runāt tikai pēc lietotāja pieskāriena — izsauc to pogas klikšķī.
  unlock() {
    if (this.recorded) this.recorded.unlock();
    if (this.neural) this.neural.unlock();
    if (!this.ok) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* nav svarīgi */ }
  }
  prefetch(parts) {
    if (!parts) return;
    if (this.recorded && this.recorded.ready && this.recorded.has(parts)) this.recorded.prefetch(parts);
    else if (this.neural && this.neural.ready) this.neural.prefetch(parts);
  }
  // urgent — pārtrauc to, kas tiek runāts (piem. pēc maršruta pārrēķina vecās norādes vairs neder).
  say(text, urgent = false, parts = null) {
    if (!this.enabled || !text) return;
    parts = parts || [text];
    const now = Date.now();
    if (!urgent && this.last && this.last.text === text && now - this.last.at < 4000) return;   // dubultā ziņa
    this.last = { text, at: now };
    if (urgent) this.stop();
    if (this.recorded && this.recorded.ready && this.recorded.say(parts, urgent)) return;
    this._fallback(text, parts, urgent);
  }
  _fallback(text, parts, urgent) {
    if (this.neural && this.neural.ready) { this.neural.say(parts, urgent); return; }
    if (!this.ok) return;
    try {
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(voiceNormalize(text));
      u.lang = 'lv-LV';
      if (this.voice) u.voice = this.voice;
      u.rate = 0.95; u.pitch = 1.0; u.volume = 1.0;
      speechSynthesis.speak(u);
    } catch { /* runa nav pieejama */ }
  }
  stop() {
    if (this.recorded) this.recorded.stop();
    if (this.neural) this.neural.stop();
    if (this.ok) try { speechSynthesis.cancel(); } catch { /* */ }
  }
}

// ---------- Ekrāns neizslēdzas navigācijas laikā (Screen Wake Lock) ----------
class ScreenAwake {
  constructor() { this.lock = null; this.want = false; this.ok = typeof navigator !== 'undefined' && 'wakeLock' in navigator; }
  async on() {
    this.want = true;
    if (!this.ok || this.lock) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch { this.lock = null; }
  }
  async off() {
    this.want = false;
    if (this.lock) { try { await this.lock.release(); } catch { /* */ } this.lock = null; }
  }
  // Pēc atgriešanās lietotnē pārlūks atbrīvo bloķējumu — to atjauno.
  resume() { if (this.want && !this.lock && typeof document !== 'undefined' && document.visibilityState === 'visible') this.on(); }
}

if (typeof module !== 'undefined') {
  module.exports = { voicePhraseLibrary, voiceClipKey, voiceNormalize, voiceItem, voiceAlertHead, voiceThen, voiceManeuverSamples, VOICE_FIXED, voiceManeuverShort, lvNumber, voiceDistancePhrases, withParts, lowerFirst, maneuverTextForVoice, voiceDistance, voiceForManeuver, voiceForAlert, voiceDuration, voiceThresholds, voiceWorthy, Voice, ScreenAwake };
}
