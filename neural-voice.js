// ---------- Dabiska latviešu balss (neironu tīkls, darbojas pašā telefonā) ----------
// Piper balsis "Rūdolfs" / "Aivars" (CC0, RaivisDejus, Hugging Face). Modelis (~63 MB)
// tiek lejupielādēts vienreiz un glabāts telefonā; runa tiek ģenerēta ierīcē (onnxruntime-web).
// Teksts → fonēmas (espeak-ng, WASM) → modelis → skaņa (Web Audio).

const NEURAL_VOICES = {
  rudolfs: { label: 'Rūdolfs', url: 'https://huggingface.co/RaivisDejus/Piper-lv_LV-Rudolfs-medium/resolve/main/lv_LV-rudolfs-medium.onnx' },
  aivars:  { label: 'Aivars',  url: 'https://huggingface.co/RaivisDejus/Piper-lv_LV-Aivars-medium/resolve/main/lv_LV-aivars-medium.onnx' },
};
const NV_ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/+esm';
const NV_ORT_WASM = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
const NV_PHONEMIZE = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-o91UDS6e.js/+esm';
const NV_PHON_WASM = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const NV_CACHE = 'cz-voice-v1';
const NV_WORKER_URL = 'neural-worker.js?v=44';

class NeuralVoice {
  constructor() {
    this.id = null; this.session = null; this.cfg = null; this.ort = null; this.createPhonemize = null;
    this.ctx = null; this.clips = new Map();      // teksts → AudioBuffer (gatavie teikumi)
    this.pending = new Map();                    // teksts → Promise<AudioBuffer>
    this.queue = []; this.playing = null; this.loading = null; this.progress = 0;
    this.worker = null; this.jobs = new Map(); this.jobId = 0;   // ģenerēšana fonā (Web Worker)
  }
  get ready() { return !!this.session; }

  // Vai modelis jau ir telefonā (nav jālejupielādē)?
  async isDownloaded(id) {
    try { const c = await caches.open(NV_CACHE); return !!(await c.match(NEURAL_VOICES[id].url)); } catch { return false; }
  }
  async _fetchCached(url, onProgress) {
    let cache = null;
    try { cache = await caches.open(NV_CACHE); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch { cache = null; }
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (onProgress && total) onProgress(got / total);
    }
    const blob = new Blob(chunks);
    if (cache) try { await cache.put(url, new Response(blob)); } catch { /* vietas nepietiek — strādās arī tā */ }
    return blob.arrayBuffer();
  }
  // Ielādē balsi (lejupielāde ar progresu, ja vēl nav telefonā).
  load(id, onProgress) {
    if (this.id === id && (this.session || this.loading)) return this.loading || Promise.resolve();
    this.id = id; this.session = null; this.clips.clear(); this.pending.clear();
    const v = NEURAL_VOICES[id];
    this.loading = (async () => {
      this.cfg = JSON.parse(new TextDecoder().decode(await this._fetchCached(v.url + '.json')));
      const model = await this._fetchCached(v.url, p => { this.progress = p; if (onProgress) onProgress(p); });
      // Vispirms fonā (lapa neraustās). Ja pārlūks to neprot — vecais veids lapas pavedienā.
      if (await this._startWorker(model, this.cfg)) { if (this.id === id) this.session = 'worker'; return; }
      const local = await this._fetchCached(v.url);       // modelis nodots fonam — paņem vēlreiz no krātuves
      const [ort, ph] = await Promise.all([import(NV_ORT), import(NV_PHONEMIZE)]);
      ort.env.wasm.wasmPaths = NV_ORT_WASM;
      ort.env.wasm.numThreads = 1;
      this.ort = ort; this.createPhonemize = ph.createPiperPhonemize;
      const session = await ort.InferenceSession.create(local);
      if (this.id === id) this.session = session;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  _startWorker(model, cfg) {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (typeof Worker === 'undefined') return Promise.resolve(false);
    let w;
    try { w = new Worker(NV_WORKER_URL, { type: 'module' }); } catch { return Promise.resolve(false); }
    return new Promise(resolve => {
      const done = ok => { clearTimeout(timer); if (!ok) w.terminate(); else this.worker = w; resolve(ok); };
      const timer = setTimeout(() => done(false), 90000);
      w.onerror = () => done(false);
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') return done(true);
        if (m.type === 'fail') { console.warn('Balss fonā nestrādā:', m.msg); return done(false); }
        const job = this.jobs.get(m.id);
        if (!job) return;
        this.jobs.delete(m.id);
        if (m.type === 'audio') job.ok(m); else job.bad(new Error(m.msg));
      };
      w.postMessage({ type: 'init', model, cfg }, [model]);
    });
  }
  _workerSynth(text) {
    return new Promise((ok, bad) => {
      const id = ++this.jobId;
      this.jobs.set(id, { ok, bad });
      this.worker.postMessage({ type: 'synth', id, text });
    });
  }
  // Pārlūks atļauj skaņu tikai pēc pieskāriena — izsauc pogas klikšķī.
  unlock() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start();
    } catch { /* nav skaņas */ }
  }
  _phonemes(text) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('phonemize timeout')), 10000);
      // Fonēmas atnāk kā JSON (print) vai kļūdas ziņā (printErr), ja kādas fonēmas iebūvētajā tabulā nav.
      const grab = s => { const i = String(s).indexOf('{'); if (i < 0) return; try { const j = JSON.parse(String(s).slice(i)); clearTimeout(timer); resolve(j.phonemes); } catch { /* ne JSON */ } };
      try {
        const m = await this.createPhonemize({
          print: grab, printErr: grab,
          locateFile: u => u.endsWith('.wasm') ? NV_PHON_WASM + '.wasm' : u.endsWith('.data') ? NV_PHON_WASM + '.data' : u,
        });
        m.callMain(['-l', this.cfg.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  }
  // Teksts → AudioBuffer (ar kešatmiņu; vienādu tekstu ģenerē tikai vienreiz).
  synth(text) {
    if (this.clips.has(text)) return Promise.resolve(this.clips.get(text));
    if (this.pending.has(text)) return this.pending.get(text);
    const p = (async () => {
      if (!this.session) throw new Error('voice not ready');
      if (this.worker) {
        const r = await this._workerSynth(text);
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const wb = this.ctx.createBuffer(1, r.pcm.length, r.rate);
        wb.copyToChannel(r.pcm, 0);
        if (this.clips.size > 150) this.clips.delete(this.clips.keys().next().value);
        this.clips.set(text, wb);
        return wb;
      }
      const ph = await this._phonemes(text);
      const map = this.cfg.phoneme_id_map, id = x => map[x][0];
      const ids = [id('^'), id('_')];
      for (const x of ph) if (map[x]) ids.push(id(x), id('_'));
      ids.push(id('$'));
      const ort = this.ort, inf = this.cfg.inference;
      const out = await this.session.run({
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        // lēnāk (×1,3) un skaidrāk (mazāk "trokšņa" izrunā)
        scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale * 0.75, inf.length_scale * 1.3, inf.noise_w * 0.7]), [3]),
      });
      const pcm = out.output.data, rate = this.cfg.audio.sample_rate;
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = this.ctx.createBuffer(1, pcm.length, rate);
      buf.copyToChannel(pcm instanceof Float32Array ? pcm : Float32Array.from(pcm), 0);
      if (this.clips.size > 150) this.clips.delete(this.clips.keys().next().value);
      this.clips.set(text, buf);
      return buf;
    })().finally(() => this.pending.delete(text));
    this.pending.set(text, p);
    return p;
  }
  // Iepriekš sagatavo teikumus (fonā), lai runājot nebūtu aizkaves.
  prefetch(texts) {
    if (!this.session) return;
    (async () => {
      for (const t of texts) {
        try { await this.synth(t); } catch { return; }
        // Bez fona pavediena katrs teikums aptur lapu — tad starp tiem dod lapai elpot.
        if (!this.worker) await new Promise(r => setTimeout(r, 400));
      }
    })();
  }
  // Runā daļas pēc kārtas (piem. "Pēc trīssimt metriem" + "pagriezies pa labi").
  async say(parts, urgent) {
    if (!this.session) return false;
    if (urgent) this.stop();
    const job = { parts, cancelled: false };
    this.queue.push(job);
    if (!this.playing) this._next();
    return true;
  }
  async _next() {
    const job = this.queue.shift();
    if (!job) { this.playing = null; return; }
    this.playing = job;
    try {
      const bufs = await Promise.all(job.parts.map(t => this.synth(t)));
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      for (let i = 0; i < bufs.length; i++) {
        const b = bufs[i];
        if (job.cancelled) break;
        if (i) await new Promise(r => setTimeout(r, 120));      // īsa pauze starp daļām
        await new Promise(res => {
          const s = this.ctx.createBufferSource();
          s.buffer = b; s.connect(this.ctx.destination);
          s.onended = res; job.src = s; s.start();
        });
      }
    } catch { /* izlaiž */ }
    this._next();
  }
  stop() {
    for (const j of this.queue) j.cancelled = true;
    this.queue = [];
    if (this.playing) { this.playing.cancelled = true; try { this.playing.src && this.playing.src.stop(); } catch { /* */ } }
  }
}
