// ---------- Dabiskās balss ģenerēšana fonā (Web Worker) ----------
// Neironu tīkls (Piper) un fonēmu programma darbojas šeit, nevis lapas galvenajā pavedienā —
// tāpēc karte, meklēšana un poga nekad "neiesalst", kamēr balss sagatavo teikumus.
// Ziņas: { type:'init', model:ArrayBuffer, cfg } → { type:'ready' } | { type:'fail', msg }
//        { type:'synth', id, text }              → { type:'audio', id, pcm:Float32Array, rate } | { type:'error', id, msg }

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/+esm';
const ORT_WASM = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
const PHONEMIZE = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-o91UDS6e.js/+esm';
const PHON_WASM = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';

let ort = null, createPhonemize = null, session = null, cfg = null;
let chain = Promise.resolve();          // pa vienam teikumam (modelis nav paredzēts paralēlai darbībai)

function phonemes(text) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phonemize timeout')), 10000);
    const grab = s => { const i = String(s).indexOf('{'); if (i < 0) return; try { const j = JSON.parse(String(s).slice(i)); clearTimeout(timer); resolve(j.phonemes); } catch { /* ne JSON */ } };
    try {
      const m = await createPhonemize({
        print: grab, printErr: grab,
        locateFile: u => u.endsWith('.wasm') ? PHON_WASM + '.wasm' : u.endsWith('.data') ? PHON_WASM + '.data' : u,
      });
      m.callMain(['-l', cfg.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

async function synth(text) {
  const ph = await phonemes(text);
  const map = cfg.phoneme_id_map, id = x => map[x][0];
  const ids = [id('^'), id('_')];
  for (const x of ph) if (map[x]) ids.push(id(x), id('_'));
  ids.push(id('$'));
  const inf = cfg.inference;
  const out = await session.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    // lēnāk (×1,3) un skaidrāk (mazāk "trokšņa" izrunā)
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale * 0.75, inf.length_scale * 1.3, inf.noise_w * 0.7]), [3]),
  });
  return Float32Array.from(out.output.data);      // kopija (nevis skats uz WASM atmiņu) — to var droši nodot lapai
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const [o, ph] = await Promise.all([import(ORT), import(PHONEMIZE)]);
      ort = o; createPhonemize = ph.createPiperPhonemize;
      ort.env.wasm.wasmPaths = ORT_WASM;
      ort.env.wasm.numThreads = 1;
      cfg = m.cfg;
      session = await ort.InferenceSession.create(m.model);
      self.postMessage({ type: 'ready' });
    } catch (err) { self.postMessage({ type: 'fail', msg: String(err && err.message || err) }); }
    return;
  }
  if (m.type === 'synth') {
    chain = chain.then(async () => {
      try {
        const pcm = await synth(m.text);
        self.postMessage({ type: 'audio', id: m.id, pcm, rate: cfg.audio.sample_rate }, [pcm.buffer]);
      } catch (err) { self.postMessage({ type: 'error', id: m.id, msg: String(err && err.message || err) }); }
    });
  }
};
