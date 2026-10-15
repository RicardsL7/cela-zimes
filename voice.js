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
  if (m.type === 'new name') return false;
  if (m.type === 'continue' && (!m.modifier || m.modifier === 'straight')) return false;
  if (m.type === 'depart') return false;
  return true;
}

// Īss manevrs runai (bez ielas nosaukuma): "pagriezies pa labi", "aplī brauc otrajā izbrauktuvē".
const LV_ORD_LOC = ['', 'pirmajā', 'otrajā', 'trešajā', 'ceturtajā', 'piektajā', 'sestajā', 'septītajā', 'astotajā'];
function voiceManeuverShort(step) {
  const m = (step && step.maneuver) || {}, type = m.type, mod = m.modifier || '';
  const side = /left/.test(mod) ? 'pa kreisi' : /right/.test(mod) ? 'pa labi' : '';
  switch (type) {
    case 'arrive': return 'galamērķis';
    case 'roundabout': case 'rotary': case 'exit roundabout': case 'exit rotary':
      return m.exit && LV_ORD_LOC[m.exit] ? `aplī brauc ${LV_ORD_LOC[m.exit]} izbrauktuvē` : 'brauc pa apli';
    case 'merge': return 'iekļaujies satiksmē' + (side ? ' ' + side : '');
    case 'on ramp': return 'brauc uzbrauktuvē' + (side ? ' ' + side : '');
    case 'off ramp': return 'nobrauc' + (side ? ' ' + side : '');
    case 'fork': return 'turies ' + (side || 'taisni');
    case 'end of road': return 'ceļa galā pagriezies ' + side;
  }
  if (mod === 'uturn') return 'apgriezies';
  if (!side) return 'turpini taisni';
  if (mod.startsWith('slight')) return 'nogriezies ' + side;
  if (mod.startsWith('sharp')) return 'strauji pagriezies ' + side;
  return 'pagriezies ' + side;
}
// Ķēdē pievieno tikai virzienu: "…, tad pa labi"
function voiceThen(step) {
  const t = voiceManeuverShort(step);
  return /^pagriezies /.test(t) ? t.replace(/^pagriezies /, '') : t;
}

// Kad runāt: vienreiz par katru manevru, šajā attālumā (atkarībā no ātruma).
function voiceThresholds(speedKmh) {
  const v = speedKmh || 0;
  return { near: v >= 75 ? 500 : v >= 45 ? 250 : 150 };
}

// Viens īss teikums par manevru: "Pēc simt piecdesmit metriem pagriezies pa kreisi".
// Ja nākamais manevrs seko tūlīt (< 120 m), to pievieno tajā pašā teikumā ("…, tad pa labi")
// un vēlāk par to vairs nerunā. said — Set ar jau pateiktajiem manevriem.
function voiceForManeuver(stepId, step, toNext, speedKmh, said, after = null, gapAfter = Infinity) {
  if (!voiceWorthy(step) || said.has(stepId + ':said')) return null;
  if (toNext > voiceThresholds(speedKmh).near + 20) return null;
  said.add(stepId + ':said');
  const arrive = step.maneuver && step.maneuver.type === 'arrive';
  if (arrive) {
    said.add('arrived');
    return { key: stepId + ':said', text: toNext < 40 ? 'Esi ieradies galamērķī' : voiceDistance(toNext) + ' galamērķis',
      parts: toNext < 40 ? ['Esi ieradies galamērķī'] : [voiceDistance(toNext), 'galamērķis'] };
  }
  let what = voiceManeuverShort(step);
  if (after && voiceWorthy(after) && gapAfter < 120 && !(after.maneuver && after.maneuver.type === 'arrive')) {
    what += ', tad ' + voiceThen(after);
    said.add((stepId + 1) + ':said');
  }
  if (toNext < 40) return { key: stepId + ':said', text: lowerFirstUp(what), parts: [lowerFirstUp(what)] };
  return withParts(stepId + ':said', voiceDistance(toNext), what);
}
function lowerFirstUp(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Teikums no divām daļām: attālums + darbība. Daļas balss sagatavo atsevišķi un iepriekš.
function withParts(key, a, b) { return { key, text: a + ' ' + b, parts: [a, b] }; }

// Brīdinājums par notikumu / zīmi priekšā (vienreiz par katru).
function voiceForAlert(key, label, dist, speedKmh, said) {
  const limit = (speedKmh || 0) >= 75 ? 700 : 400;
  if (dist > limit || dist < 15 || said.has('alert:' + key)) return null;
  said.add('alert:' + key);
  const head = `Uzmanību! ${label},`;
  if (dist < 60) return { key: 'alert:' + key, text: head + ' tūlīt', parts: [head + ' tūlīt'] };
  return { key: 'alert:' + key, text: head + ' ' + voiceDistance(dist).toLowerCase(), parts: [head, voiceDistance(dist)] };
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
  for (let m = 100; m < 950; m += 50) out.add(voiceDistance(m));
  for (const m of [1000, 1500, 2000, 3000]) out.add(voiceDistance(m));
  return [...out];
}

// ---------- Runātājs ----------
class Voice {
  constructor() {
    this.enabled = true;
    this.neural = null;          // NeuralVoice, ja dabiskā balss ielādēta
    this.voice = null;
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
    if (this.neural) this.neural.unlock();
    if (!this.ok) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* nav svarīgi */ }
  }
  // urgent — pārtrauc to, kas tiek runāts (piem. "Tagad pagriezies").
  say(text, urgent = false, parts = null) {
    if (!this.enabled || !text) return;
    if (this.neural && this.neural.ready) { this.neural.say(parts || [text], urgent); return; }
    if (!this.ok) return;
    try {
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'lv-LV';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
      speechSynthesis.speak(u);
    } catch { /* runa nav pieejama */ }
  }
  stop() {
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
  module.exports = { voiceManeuverShort, lvNumber, voiceDistancePhrases, withParts, lowerFirst, maneuverTextForVoice, voiceDistance, voiceForManeuver, voiceForAlert, voiceDuration, voiceThresholds, voiceWorthy, Voice, ScreenAwake };
}
