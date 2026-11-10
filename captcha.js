// Ceļa Zīmes — CAPTCHA (Cloudflare Turnstile) jauna konta izveidei un e-pasta saites pieprasīšanai (audits 2, B07).
//
// Kāpēc: anonīmu kontu varēja izveidot bez ierobežojuma, un visi limiti (ziņojumi, balsojumi, monētas) ir „uz kontu”.
// Supabase Auth ar ieslēgtu CAPTCHA pieņem /signup un /otp tikai ar derīgu Turnstile žetonu.
//
// Privātums: Cloudflare skripts tiek ielādēts TIKAI brīdī, kad vajag žetonu (konta izveide, e-pasta saite) —
// ne atverot lietotni. Cloudflare saņem IP adresi un pārlūka datus pārbaudei (privacy.html 2. un 7. punkts).
// Parasti pārbaude ir neredzama; ja Cloudflare prasa darbību, parādās neliels logs ar „Pārbaude”.
//
// Ieslēgšana: rides-config.js → captchaSiteKey (publiska atslēga no Cloudflare), Supabase → Authentication →
// Attack Protection → CAPTCHA (Turnstile + slepenā atslēga). Kamēr captchaSiteKey ir tukšs, nekas netiek ielādēts.

const CZ_TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CZ_CAPTCHA_TIMEOUT = 90000;       // ja lietotājs neatrisina 1,5 min laikā — kļūda (var mēģināt vēlreiz)
let czTurnstileLoading = null;

function czTurnstileLoad(doc = (typeof document !== 'undefined' ? document : null)) {
  if (typeof window !== 'undefined' && window.turnstile) return Promise.resolve(window.turnstile);
  if (czTurnstileLoading) return czTurnstileLoading;
  czTurnstileLoading = new Promise((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = CZ_TURNSTILE_SRC; s.async = true; s.referrerPolicy = 'strict-origin';
    s.onload = () => window.turnstile ? resolve(window.turnstile) : reject(Object.assign(new Error('captcha'), { code: 'captcha' }));
    s.onerror = () => { czTurnstileLoading = null; s.remove(); reject(Object.assign(new Error('captcha'), { code: 'captcha' })); };
    doc.head.appendChild(s);
  });
  return czTurnstileLoading;
}

// Logs, kas parādās tikai, ja Cloudflare prasa darbību
function czCaptchaBox(doc = (typeof document !== 'undefined' ? document : null)) {
  let box = doc.getElementById('czCaptcha');
  if (box) return box;
  box = doc.createElement('div');
  box.id = 'czCaptcha'; box.className = 'cz-captcha'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'czCaptchaT');
  const card = doc.createElement('div'); card.className = 'cz-captcha-card';
  const t = doc.createElement('p'); t.id = 'czCaptchaT'; t.className = 'cz-captcha-t'; t.textContent = 'Pārbaude, ka neesi robots';
  const w = doc.createElement('div'); w.className = 'cz-captcha-w';
  const c = doc.createElement('button'); c.type = 'button'; c.className = 'cz-captcha-x'; c.textContent = 'Atcelt';
  card.append(t, w, c); box.append(card); doc.body.appendChild(box);
  return box;
}

// Viens Turnstile žetons (derīgs 5 min, vienreiz). Kļūda → { code: 'captcha' | 'captcha_cancel' | 'captcha_needed' }.
// interactive=false (piem. braucot): ja Cloudflare prasa darbību, logu nerāda — uzreiz 'captcha_needed'.
async function czCaptchaToken(siteKey, doc = (typeof document !== 'undefined' ? document : null), { interactive = true } = {}) {
  if (!siteKey) return null;
  const ts = await czTurnstileLoad(doc);
  const box = czCaptchaBox(doc), holder = box.querySelector('.cz-captcha-w'), cancel = box.querySelector('.cz-captcha-x');
  holder.textContent = '';
  return new Promise((resolve, reject) => {
    let id = null, done = false;
    const fail = code => finish(null, Object.assign(new Error(code), { code }));
    const finish = (tok, err) => {
      if (done) return; done = true;
      clearTimeout(timer); cancel.onclick = null; box.hidden = true;
      try { if (id !== null) ts.remove(id); } catch { /* */ }
      err ? reject(err) : resolve(tok);
    };
    const timer = setTimeout(() => fail('captcha'), CZ_CAPTCHA_TIMEOUT);
    cancel.onclick = () => fail('captcha_cancel');
    try {
      id = ts.render(holder, {
        sitekey: siteKey, action: 'auth', language: 'lv', appearance: 'interaction-only', retry: 'auto',
        callback: tok => finish(tok),
        'error-callback': () => fail('captcha'),
        'expired-callback': () => fail('captcha'),
        'timeout-callback': () => fail('captcha'),
        'before-interactive-callback': () => {
          if (!interactive) { fail('captcha_needed'); return; }
          box.hidden = false; try { cancel.focus(); } catch { /* */ }
        },
        'after-interactive-callback': () => { box.hidden = true; },
        'unsupported-callback': () => fail('captcha'),
      });
    } catch { fail('captcha'); }
  });
}

if (typeof module !== 'undefined') module.exports = { czCaptchaToken, czTurnstileLoad, CZ_TURNSTILE_SRC };
