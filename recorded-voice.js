// ---------- Ierakstītā balss (Google Chirp 3 HD, ģenerēta iepriekš) ----------
// Visas frāzes, ko navigācija var pateikt, ir ierakstītas vienreiz ar tools/gen-voice.mjs un
// glabājas lapā kā skaņas faili (voice/lv/*.mp3 + manifest.json). Telefonā tās tiek saglabātas,
// tāpēc runa ir bez aizkaves un darbojas arī bez interneta. API atslēga lapā NAV vajadzīga.
// Ja kādas frāzes ierakstā nav vai ieraksti nav pieejami, Voice izmanto nākamo balsi ķēdē.

const RV_BASE = 'voice/lv/';
const RV_CACHE = 'cz-voice-rec-v1';

// Tīra funkcija (testējama): manifest + teikuma daļas → failu URL saraksts vai null, ja kāda trūkst.
function recordedFilesFor(manifest, parts, base = RV_BASE) {
  if (!manifest || !manifest.clips || !parts || !parts.length) return null;
  const out = [];
  for (const p of parts) {
    const f = manifest.clips[voiceClipKey(p)];
    if (!f) return null;
    out.push(base + f);
  }
  return out;
}

class RecordedVoice {
  constructor(base = RV_BASE) {
    this.base = base; this.manifest = null; this.ctx = null;
    this.bufs = new Map();        // URL → AudioBuffer
    this.pending = new Map();     // URL → Promise<AudioBuffer>
    this.queue = []; this.playing = null; this.gain = null;
    this.onFail = null;           // (parts) → ja ierakstu neizdevās atskaņot, runā cita balss
  }
  get ready() { return !!this.manifest; }
  get label() { return (this.manifest && this.manifest.label) || 'Google'; }

  // Ielādē sarakstu (manifest.json). Bez interneta — no telefona krātuves.
  async load() {
    const url = this.base + 'manifest.json';
    let m = null, cache = null;
    try { cache = await caches.open(RV_CACHE); } catch { cache = null; }
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) {
        m = await res.clone().json();
        if (cache) try { await cache.put(url, res); } catch { /* */ }
      }
    } catch { /* nav tīkla */ }
    if (!m && cache) try { const hit = await cache.match(url); if (hit) m = await hit.json(); } catch { /* */ }
    if (!m || !m.clips || !Object.keys(m.clips).length) return false;
    this.manifest = m;
    return true;
  }
  // Fonā saglabā visus ierakstus telefonā (~2–3 MB), lai strādā bez interneta.
  async warm(onProgress) {
    if (!this.manifest) return;
    let cache; try { cache = await caches.open(RV_CACHE); } catch { return; }
    const urls = [...new Set(Object.values(this.manifest.clips))].map(f => this.base + f);
    let done = 0;
    const worker = async () => {
      while (urls.length) {
        const u = urls.pop();
        try { if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); } } catch { /* nākamreiz */ }
        done++; if (onProgress) onProgress(done);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  has(parts) { return !!recordedFilesFor(this.manifest, parts, this.base); }

  _ctx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Kompresors — vienmērīgs skaļums un nekādas "klipšēšanas" pīķos.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
      this.gain = this.ctx.createGain(); this.gain.gain.value = 1.0;
      comp.connect(this.gain); this.gain.connect(this.ctx.destination);
      this.out = comp;
    }
    return this.ctx;
  }
  unlock() {
    try {
      const ctx = this._ctx();
      if (ctx.state === 'suspended') ctx.resume();
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start();
    } catch { /* nav skaņas */ }
  }
  async _buf(url) {
    if (this.bufs.has(url)) return this.bufs.get(url);
    if (this.pending.has(url)) return this.pending.get(url);
    const p = (async () => {
      let res = null;
      try { const c = await caches.open(RV_CACHE); res = await c.match(url); } catch { /* */ }
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        try { const c = await caches.open(RV_CACHE); await c.put(url, res.clone()); } catch { /* */ }
      }
      const ab = await res.arrayBuffer();
      const buf = await new Promise((ok, bad) => this._ctx().decodeAudioData(ab, ok, bad));
      if (this.bufs.size > 200) this.bufs.delete(this.bufs.keys().next().value);
      this.bufs.set(url, buf);
      return buf;
    })().finally(() => this.pending.delete(url));
    this.pending.set(url, p);
    return p;
  }
  // Iepriekš atkodē (lai runājot nav aizkaves).
  prefetch(parts) {
    const urls = recordedFilesFor(this.manifest, parts, this.base);
    if (urls) for (const u of urls) this._buf(u).catch(() => {});
  }
  // Runā daļas pēc kārtas. Atgriež false, ja kādas daļas ierakstā nav (tad runās cita balss).
  say(parts, urgent) {
    const urls = recordedFilesFor(this.manifest, parts, this.base);
    if (!urls) return false;
    if (urgent) this.stop();
    const key = parts.join('|');
    if (this.queue.some(j => j.key === key) || (this.playing && this.playing.key === key)) return true;   // tas pats jau rindā
    this.queue.push({ key, parts, urls, cancelled: false, at: Date.now() });
    if (!this.playing) this._next();
    return true;
  }
  async _next() {
    const job = this.queue.shift();
    if (!job) { this.playing = null; return; }
    this.playing = job;
    try {
      const bufs = await Promise.all(job.urls.map(u => this._buf(u)));
      const ctx = this._ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      // Novecojis teikums (gaidīja rindā > 8 s) — vairs neatbilst vietai uz ceļa, izlaiž.
      if (!job.cancelled && Date.now() - job.at < 8000) {
        for (let i = 0; i < bufs.length && !job.cancelled; i++) {
          if (i) await new Promise(r => setTimeout(r, 90));
          await new Promise(res => {
            const s = ctx.createBufferSource();
            s.buffer = bufs[i]; s.connect(this.out);
            s.onended = res; job.src = s; s.start();
          });
        }
      }
    } catch (err) {
      console.warn('Ieraksts netika atskaņots', err);
      if (!job.cancelled && this.onFail) this.onFail(job.parts);
    }
    this._next();
  }
  stop() {
    for (const j of this.queue) j.cancelled = true;
    this.queue = [];
    if (this.playing) { this.playing.cancelled = true; try { this.playing.src && this.playing.src.stop(); } catch { /* */ } }
  }
}

if (typeof module !== 'undefined') module.exports = { recordedFilesFor, RecordedVoice };
