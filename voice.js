// ---------- Balss norādes (latviski) ----------
// Teksti un lēmumi "ko un kad teikt" — tīras funkcijas (testējamas);
// runāšana — pārlūka runas sintēze (speechSynthesis) ar latviešu balsi, ja tāda ir.

// "Pēc 300 metriem" · "Pēc 1 kilometra" · "Pēc pusotra kilometra" · "Pēc 2 kilometriem"
function voiceDistance(m) {
  if (m >= 1750) return `Pēc ${Math.round(m / 1000)} kilometriem`;
  if (m >= 1250) return 'Pēc pusotra kilometra';
  if (m >= 950) return 'Pēc 1 kilometra';
  const r = m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  return `Pēc ${r} metriem`;
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

// Attālumi (m), kuros runāt, atkarībā no ātruma.
function voiceThresholds(speedKmh) {
  const v = speedKmh || 0;
  return {
    early: v >= 75 ? 1000 : v >= 45 ? 500 : 300,
    near: v >= 75 ? 300 : 120,
    now: Math.max(25, (v / 3.6) * 3),            // ~3 s līdz manevram
  };
}

// Ko teikt tagad par nākamo manevru. said — Set ar jau pateiktajiem posmiem šim manevram.
// Atgriež { key, text } vai null.
function voiceForManeuver(stepId, step, toNext, speedKmh, said) {
  if (!voiceWorthy(step)) return null;
  const th = voiceThresholds(speedKmh);
  const arrive = step.maneuver && step.maneuver.type === 'arrive';
  if (toNext <= th.now) {
    if (said.has(stepId + ':now')) return null;
    said.add(stepId + ':now'); said.add(stepId + ':near'); said.add(stepId + ':early');
    return { key: stepId + ':now', text: arrive ? 'Esi ieradies galamērķī' : maneuverTextForVoice(step) };
  }
  if (toNext <= th.near + 40) {
    if (said.has(stepId + ':near')) return null;
    said.add(stepId + ':near'); said.add(stepId + ':early');
    return { key: stepId + ':near', text: `${voiceDistance(toNext)} ${arrive ? 'galamērķis' : lowerFirst(maneuverTextForVoice(step))}` };
  }
  if (toNext <= th.early && toNext > th.near + 120) {
    if (said.has(stepId + ':early')) return null;
    said.add(stepId + ':early');
    return { key: stepId + ':early', text: `${voiceDistance(toNext)} ${arrive ? 'galamērķis' : lowerFirst(maneuverTextForVoice(step))}` };
  }
  return null;
}

// Brīdinājums par notikumu / zīmi priekšā (vienreiz par katru).
function voiceForAlert(key, label, dist, speedKmh, said) {
  const limit = (speedKmh || 0) >= 75 ? 700 : 400;
  if (dist > limit || dist < 15 || said.has('alert:' + key)) return null;
  said.add('alert:' + key);
  const when = dist < 60 ? 'tūlīt' : voiceDistance(dist).toLowerCase();
  return { key: 'alert:' + key, text: `Uzmanību! ${label}, ${when}` };
}

// "12 minūtes" · "1 stunda 5 minūtes"
function voiceDuration(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  const mins = n => n + (n % 10 === 1 && n % 100 !== 11 ? ' minūte' : ' minūtes');
  if (min < 60) return mins(min);
  const h = Math.floor(min / 60), m = min % 60;
  return (h === 1 ? '1 stunda' : h + ' stundas') + (m ? ' ' + mins(m) : '');
}

// ---------- Runātājs ----------
class Voice {
  constructor() {
    this.enabled = true;
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
    if (!this.ok) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* nav svarīgi */ }
  }
  // urgent — pārtrauc to, kas tiek runāts (piem. "Tagad pagriezies").
  say(text, urgent = false) {
    if (!this.ok || !this.enabled || !text) return;
    try {
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'lv-LV';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
      speechSynthesis.speak(u);
    } catch { /* runa nav pieejama */ }
  }
  stop() { if (this.ok) try { speechSynthesis.cancel(); } catch { /* */ } }
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
  module.exports = { lowerFirst, maneuverTextForVoice, voiceDistance, voiceForManeuver, voiceForAlert, voiceDuration, voiceThresholds, voiceWorthy, Voice, ScreenAwake };
}
