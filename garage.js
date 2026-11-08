// Ceļa Zīmes — "Garāža": coin balance and the skin shop (v124; v125: 8 characters, mythic tier, filter).
// Server: supabase/coins-1.sql (wallet_get, skins_list, skin_buy, skin_equip). All coin logic runs on the
// server — this file only shows the state and sends requests. Skin images: skins.js.
//
//   • The "Garāža" button shows the balance. Coins are earned by anyone (also anonymous accounts) by
//     answering confirmation prompts; buying needs an account with a confirmed e-mail.
//   • Filter chips: all / mine / one character (remembered in this browser).
//   • Cards: 2 columns, cheapest first, border colour = rarity (common, rare, epic, mythic). States: locked (progress "120 / 300"),
//     affordable ("Pirkt" + confirmation), owned ("Izmantot"), equipped (highlight + ✓).
//   • "Apskatīt" shows on the real map how other drivers will see you. You yourself always keep the
//     green arrow — your skin is shown to OTHER drivers (presence.js, only with "Rādīt mani citu kartē" — A16).

const garage = {
  wallet: null,          // { balance, earned_today, daily_cap, equipped, can_spend, owned: [] } or null (no account yet)
  skins: SKINS_DEFAULT,  // catalogue (server list replaces it)
  serverOk: null,        // false — coins SQL not installed yet (404)
  busy: false,
  user: undefined,       // user id the wallet belongs to
  previewMarker: null,
  filter: (() => { try { return localStorage.getItem('cz.garage.filter') || 'all'; } catch { return 'all'; } })(),
};

// Filter chips above the grid: "Visi", "Mani" (owned) and one per character present in the catalogue.
function garageRenderChips() {
  const box = $('garageChars');
  if (!box) return;
  const chars = [...new Set(garage.skins.map(s => s.character || 'fox'))];
  if (garage.filter !== 'all' && garage.filter !== 'mine' && !chars.includes(garage.filter)) garage.filter = 'all';
  const opts = [['all', 'Visi'], ['mine', 'Mani'], ...chars.map(c => [c, SKIN_CHARS[c] || c])];
  box.textContent = '';
  for (const [k, label] of opts) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'gr-chip' + (garage.filter === k ? ' on' : ''); b.setAttribute('aria-pressed', garage.filter === k);
    if (k !== 'all' && k !== 'mine') {
      const first = garage.skins.find(s => (s.character || 'fox') === k);
      if (first) { const im = document.createElement('img'); im.src = skinDataUrl(first.id); im.alt = ''; im.width = 22; im.height = 23; b.appendChild(im); }
    }
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', () => {
      garage.filter = k;
      try { localStorage.setItem('cz.garage.filter', k); } catch { /* */ }
      garageRender();
    });
    box.appendChild(b);
  }
  const on = box.querySelector('.gr-chip.on');                       // keep the chosen chip visible
  if (on && box.scrollWidth > box.clientWidth) box.scrollLeft = Math.max(0, on.offsetLeft - box.clientWidth / 2 + on.offsetWidth / 2);
}
// Skins shown for the current filter, cheapest first.
function garageVisible(skins, filter, w) {
  return skins.filter(s => filter === 'all' ? true
    : filter === 'mine' ? !!(w && Array.isArray(w.owned) && w.owned.includes(s.id))
    : (s.character || 'fox') === filter).sort((a, b) => a.price - b.price || (a.sort || 0) - (b.sort || 0));
}

function garageApi() { return typeof reportsApi !== 'undefined' && reportsApi ? reportsApi : null; }
function garageCoins(n) { return Number(n || 0).toLocaleString('lv-LV'); }

// Balance on the button (also called by app-gl.js after a confirmation answer).
function garageSetBalance(n) {
  if (garage.wallet) garage.wallet.balance = n; else garage.wallet = { balance: n, owned: [], equipped: null, can_spend: false };
  const b = $('garageBal');
  if (b) { b.textContent = garageCoins(n); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  if (!$('garageSheet').hidden) garageRender();
}

async function garageLoad({ create = false } = {}) {
  const api = garageApi();
  if (!api) return;
  try {
    const [skins, wallet] = await Promise.all([api.skins(), api.wallet({ create })]);
    if (Array.isArray(skins) && skins.length) garage.skins = skins.map(s => ({ ...s, price: +s.price, rarity: s.rarity || skinRarity(+s.price), character: s.animal || 'fox' }));
    garage.wallet = wallet;
    garage.serverOk = true;
  } catch (e) {
    if (e.status === 404) garage.serverOk = false;          // functions not installed yet
    else console.warn('Garāža nav ielādēta', e);
  }
  const b = $('garageBal');
  if (b) b.textContent = garageCoins(garage.wallet ? garage.wallet.balance : 0);
  if (typeof presenceSetSkin === 'function') presenceSetSkin(garage.wallet ? garage.wallet.equipped : null);
  if (!$('garageSheet').hidden) garageRender();
}

function garageOpen() {
  $('garageSheet').hidden = false;
  garageMsg('');
  garageRender();
  garageLoad();
}
function garageMsg(text, kind = 'err') {
  const m = $('garageMsg');
  m.textContent = text; m.hidden = !text; m.className = 'rep-msg ' + kind;
}

// Card state for a skin: 'equipped' | 'owned' | 'buy' | 'locked'
function garageCardState(skin, w) {
  const owned = !!(w && Array.isArray(w.owned) && w.owned.includes(skin.id));
  if (owned) return w.equipped === skin.id ? 'equipped' : 'owned';
  return (w ? +w.balance : 0) >= skin.price ? 'buy' : 'locked';
}

function garageRender() {
  const w = garage.wallet, bal = w ? +w.balance : 0;
  $('garageBalance').textContent = garageCoins(bal);
  const today = $('garageToday');
  today.textContent = w && w.daily_cap ? `Šodien nopelnīts ${w.earned_today || 0} / ${w.daily_cap}` : '';
  const note = $('garageNote');
  note.hidden = false;
  if (garage.serverOk === false) note.textContent = 'Garāža vēl tiek ieslēgta serverī — monētas varēsi krāt un tērēt pavisam drīz.';
  else if (!w) note.textContent = 'Krāj monētas: braucot atbildi „JĀ” vai „NĒ”, kad tev jautā, vai notikums vēl ir uz ceļa (+10 par atbildi).';
  else if (!w.can_spend) note.textContent = 'Monētas krāj arī bez konta. Lai pirktu tēlu, vajag kontu ar apstiprinātu e-pastu.';
  else note.hidden = true;

  garageRenderChips();
  const grid = $('garageGrid');
  grid.textContent = '';
  const list = garageVisible(garage.skins, garage.filter, w);
  if (!list.length) {
    const e = document.createElement('p'); e.className = 'gr-empty';
    e.textContent = garage.filter === 'mine' ? 'Tev vēl nav neviena tēla. Krāj monētas un izvēlies savu pirmo!' : 'Šeit vēl nav tēlu.';
    grid.appendChild(e);
  }
  for (const s of list) {
    const st = garageCardState(s, w);
    const card = document.createElement('div');
    card.className = `gr-card rar-${s.rarity} st-${st}`;
    card.innerHTML = `<div class="gr-rar"></div><button type="button" class="gr-img" title="Apskatīt kartē"><img alt="" width="96" height="99" loading="lazy" decoding="async"></button>
      <div class="gr-name"></div><div class="gr-price"><span class="coin" aria-hidden="true"></span><b></b></div><div class="gr-act"></div>`;
    card.querySelector('.gr-rar').textContent = SKIN_RARITY_LABEL[s.rarity] || '';
    card.querySelector('img').src = skinDataUrl(s.id);
    card.querySelector('.gr-name').textContent = s.name;
    card.querySelector('.gr-price b').textContent = garageCoins(s.price);
    card.querySelector('.gr-img').addEventListener('click', () => garagePreview(s));
    const act = card.querySelector('.gr-act');
    const btn = (text, cls, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small ' + cls; b.textContent = text;
      b.disabled = garage.busy || garage.serverOk === false; b.addEventListener('click', fn); act.appendChild(b); return b;
    };
    if (st === 'equipped') {
      const ck = document.createElement('div'); ck.className = 'gr-check'; ck.textContent = '✓'; ck.setAttribute('aria-label', 'Izmantots');
      card.appendChild(ck);
      btn('Noņemt', 'ghost', () => garageEquip(null));
    } else if (st === 'owned') {
      btn('Izmantot', 'primary', () => garageEquip(s.id));
    } else if (st === 'buy') {
      btn('Pirkt', 'primary', () => garageConfirmBuy(s));
    } else {
      const lock = document.createElement('div'); lock.className = 'gr-lock';
      lock.innerHTML = '<div class="gr-lock-t">Slēgts</div><div class="gr-prog"><i></i></div><div class="gr-prog-t"></div>';
      lock.querySelector('i').style.width = Math.min(100, Math.round(bal / s.price * 100)) + '%';
      lock.querySelector('.gr-prog-t').textContent = `${garageCoins(bal)} / ${garageCoins(s.price)}`;
      act.appendChild(lock);
    }
    const look = document.createElement('button'); look.type = 'button'; look.className = 'link-btn gr-look'; look.textContent = 'Apskatīt kartē';
    look.addEventListener('click', () => garagePreview(s));
    act.appendChild(look);
    grid.appendChild(card);
  }
}

// Buying: confirmation dialog; without a confirmed account — explain and offer to create one.
function garageConfirmBuy(s) {
  const w = garage.wallet;
  const dlg = $('garageDlg');
  dlg.textContent = '';
  const box = document.createElement('div'); box.className = 'gr-dlg-box';
  const img = document.createElement('img'); img.src = skinDataUrl(s.id); img.alt = ''; img.width = 110; img.height = 113;
  const t = document.createElement('div'); t.className = 'gr-dlg-t';
  const sub = document.createElement('div'); sub.className = 'gr-dlg-s';
  const row = document.createElement('div'); row.className = 'gr-dlg-b';
  const close = () => { dlg.hidden = true; };
  const mk = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = text; b.addEventListener('click', fn); row.appendChild(b); };
  if (!w || !w.can_spend) {
    t.textContent = 'Vajag kontu';
    sub.textContent = 'Monētas tev saglabāsies. Lai pirktu tēlu, izveido kontu vai pieslēdzies un apstiprini e-pastu.';
    mk('Vēlāk', 'ghost', close);
    mk('Izveidot kontu', 'primary', () => { close(); $('garageSheet').hidden = true; if (typeof ridesOpenAccount === 'function') ridesOpenAccount(); });
  } else {
    t.textContent = `Pirkt „${s.name}”?`;
    sub.textContent = `Cena: ${garageCoins(s.price)} monētas. Pēc pirkuma paliks ${garageCoins(w.balance - s.price)}.`;
    mk('Atcelt', 'ghost', close);
    mk('Pirkt', 'primary', () => { close(); garageBuy(s); });
  }
  box.append(img, t, sub, row);
  dlg.appendChild(box);
  dlg.hidden = false;
  dlg.onclick = ev => { if (ev.target === dlg) close(); };
}

async function garageRun(fn, okText) {
  if (garage.busy) return;
  garage.busy = true; garageMsg('Sūta…', 'info'); garageRender();
  try {
    const w = await fn();
    if (w) garage.wallet = w;
    garageMsg(okText, 'ok');
    if (typeof presenceSetSkin === 'function') presenceSetSkin(garage.wallet ? garage.wallet.equipped : null);
    const b = $('garageBal'); if (b && garage.wallet) b.textContent = garageCoins(garage.wallet.balance);
  } catch (e) {
    garageMsg(reportErrorText(e.code));
    if (e.code === 'not_enough' || e.code === 'already_owned' || e.code === 'need_account') garageLoad();
  } finally { garage.busy = false; garageRender(); }
}
function garageBuy(s) { return garageRun(() => garageApi().buy(s.id), `Apsveicam! „${s.name}” ir tavs. Spied „Izmantot”, lai citi tevi redzētu šādu.`); }
function garageEquip(id) {
  const s = garage.skins.find(x => x.id === id);
  return garageRun(() => garageApi().equip(id), id ? (typeof presenceShowOn === 'function' && presenceShowOn() ? `Tagad citi braucēji tevi redz kā „${s ? s.name : id}”.`
    : `Tēls „${s ? s.name : id}” izvēlēts. Citi to redzēs, ja iestatījumos ieslēgsi „Rādīt mani citu kartē”.`)
    : 'Tēls noņemts — citi redz parasto bultiņu.');
}

// Preview on the real map: the Garage closes for a moment and the skin appears where you are
// (or in the map centre), exactly as other drivers will see it.
function garagePreview(s) {
  if (typeof map === 'undefined' || !map) return;
  $('garageSheet').hidden = true;
  if (garage.previewMarker) garage.previewMarker.remove();
  const at = state.me ? [state.me.lng, state.me.lat] : map.getCenter().toArray();
  const el = presenceMarkerEl(s.id, state.heading == null ? 0 : state.heading, true);
  const tag = document.createElement('div'); tag.className = 'gr-prev-tag'; tag.textContent = `Tā tevi redzēs citi: „${s.name}”`;
  el.prepend(tag);                                  // label above the fox, so the arrow stays on my position
  garage.previewMarker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 11] }).setLngLat(at).addTo(map);
  map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 16.5), duration: 500 });
  clearTimeout(garagePreview._t);
  const done = () => {
    clearTimeout(garagePreview._t);
    if (garage.previewMarker) { garage.previewMarker.remove(); garage.previewMarker = null; }
    $('garageSheet').hidden = false;
  };
  el.addEventListener('click', done);
  garagePreview._t = setTimeout(done, 4500);
}

function garageInit() {
  $('garageBtn').addEventListener('click', garageOpen);
  $('closeGarage').addEventListener('click', () => { $('garageSheet').hidden = true; $('garageDlg').hidden = true; });
  const a = typeof czAuthGet === 'function' ? czAuthGet() : null;
  if (a) a.onChange(sess => {                       // signed in / out / anonymous account moved → reload wallet
    const uid = sess ? sess.user_id : null;
    if (uid === garage.user) return;
    garage.user = uid; garageLoad();
  });
  garage.user = a ? a.userId : null;
  if (typeof czWhenConsent === 'function') czWhenConsent(() => garageLoad()); else garageLoad();
}

if (typeof module !== 'undefined') module.exports = { garage, garageCardState, garageVisible };
