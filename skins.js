// Ceļa Zīmes — "Garāža" skins: the orange fox on wheels in different costumes.
// Pure functions (no DOM): foxSvg() draws the fox, skinMapSvg() adds the heading arrow below it
// for the map. The same code generates the static files skins/<id>.svg and skins/<id>-map.svg.

// Draws the fox (viewBox 0 0 256 256, content may reach y = -6 for tall hats).
// o.fur [top, bottom], o.line, o.belly, o.ear, o.hub, o.iris — colour overrides;
// o.back / o.body / o.face / o.acc — extra SVG drawn behind, on the body, as the face and on top.
function foxSvg(o = {}) {
 const id = 'f', fur=o.fur||['#ffa24a','#f06a1c'], line=o.line||'#b9480f', belly=o.belly||'#fff8ef', hub=o.hub||'#ff8a2a';
 return `<svg viewBox="0 0 256 256" width="256" height="256" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fur[0]}"/><stop offset="1" stop-color="${fur[1]}"/></linearGradient>
<radialGradient id="${id}e" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="${o.iris||'#6b3a1a'}"/><stop offset="1" stop-color="#1a1210"/></radialGradient></defs>
<ellipse cx="128" cy="238" rx="66" ry="7" fill="#000" opacity=".15"/>
${o.back||''}
<path d="M168 186 Q222 182 220 140 Q218 116 200 112 Q206 140 186 156 Q170 166 160 170Z" fill="url(#${id}f)" stroke="${line}" stroke-width="3.5" stroke-linejoin="round"/>
<path d="M200 112 Q218 116 220 140 Q212 128 198 126Z" fill="${belly}"/>
<ellipse cx="128" cy="186" rx="50" ry="32" fill="url(#${id}f)" stroke="${line}" stroke-width="3.5"/>
<ellipse cx="128" cy="192" rx="28" ry="20" fill="${belly}"/>
${o.body||''}
${[94,162].map(x=>`<circle cx="${x}" cy="216" r="19" fill="#1f242c"/><circle cx="${x}" cy="216" r="9" fill="${hub}"/><circle cx="${x}" cy="216" r="3.5" fill="#1f242c"/><path d="M${x-12} ${210} a14 14 0 0 1 10 -9" stroke="#fff" stroke-width="3" opacity=".25" fill="none" stroke-linecap="round"/>`).join('')}
<path d="M56 96 Q44 44 62 22 Q92 40 104 64Z" fill="url(#${id}f)" stroke="${line}" stroke-width="3.5" stroke-linejoin="round"/>
<path d="M200 96 Q212 44 194 22 Q164 40 152 64Z" fill="url(#${id}f)" stroke="${line}" stroke-width="3.5" stroke-linejoin="round"/>
<path d="M64 80 Q58 50 66 36 Q84 48 92 66Z" fill="${o.ear||'#3b2518'}"/><path d="M192 80 Q198 50 190 36 Q172 48 164 66Z" fill="${o.ear||'#3b2518'}"/>
<path d="M128 46 C70 46 46 80 48 116 C50 150 84 166 128 166 C172 166 206 150 208 116 C210 80 186 46 128 46Z" fill="url(#${id}f)" stroke="${line}" stroke-width="3.5"/>
<path d="M50 118 Q86 104 128 132 Q170 104 206 118 C202 150 170 166 128 166 C86 166 54 150 50 118Z" fill="${belly}"/>
<path d="M112 52 Q128 62 144 52 Q136 70 128 74 Q120 70 112 52Z" fill="${belly}" opacity=".9"/>
${o.face||`${[-1,1].map(s=>`<ellipse cx="${128+s*31}" cy="108" rx="15" ry="18" fill="url(#${id}e)"/><ellipse cx="${128+s*31+5}" cy="101" rx="5.5" ry="6.5" fill="#fff"/><circle cx="${128+s*31-5}" cy="115" r="2.6" fill="#fff" opacity=".8"/>`).join('')}
<path d="M${128-31-16} 86 Q${128-31} 80 ${128-31+13} 87 M${128+31-13} 87 Q${128+31} 80 ${128+31+16} 86" stroke="${line}" stroke-width="4" fill="none" stroke-linecap="round" opacity=".7"/>`}
<path d="M118 132 Q128 126 138 132 Q136 142 128 143 Q120 142 118 132Z" fill="#1d1513"/><ellipse cx="124" cy="132" rx="3.5" ry="2" fill="#fff" opacity=".6"/>
<path d="M128 143 L128 148 M114 147 Q121 156 128 148 Q135 156 142 147" stroke="#1d1513" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<ellipse cx="80" cy="134" rx="11" ry="7" fill="#ff7c7c" opacity=".45"/><ellipse cx="176" cy="134" rx="11" ry="7" fill="#ff7c7c" opacity=".45"/>
${o.acc||''}</svg>`}

// Costume art per skin id (ids match public.skins in supabase/coins-1.sql).
const SKIN_ART = {
pilot: {body:`<path d="M80 168 Q128 186 176 168 L178 182 Q128 204 78 182Z" fill="#fff"/><path d="M150 180 Q170 200 190 196 L186 210 Q164 210 146 186Z" fill="#fff" stroke="#dfe4ea" stroke-width="2"/>`,
 acc:`<path d="M52 92 C52 34 204 34 204 92 C190 70 66 70 52 92Z" fill="#7a4a24" stroke="#4e2e14" stroke-width="3"/>
 <rect x="62" y="70" width="132" height="10" rx="5" fill="#4e2e14"/><circle cx="98" cy="70" r="20" fill="#9fd6ff" stroke="#c9a227" stroke-width="6"/><circle cx="158" cy="70" r="20" fill="#9fd6ff" stroke="#c9a227" stroke-width="6"/>
 <path d="M88 62 l10 -6 M148 62 l10 -6" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`},
  viking: {body:`<path d="M80 172 Q128 152 176 172 L176 200 Q128 214 80 200Z" fill="#8a6d4a"/><path d="M80 186 L176 186" stroke="#5e4a30" stroke-width="4" stroke-dasharray="8 6"/>`,
 acc:`<path d="M60 82 Q50 52 26 40 Q34 70 58 96Z" fill="#f4ecd8" stroke="#b9ab88" stroke-width="3" stroke-linejoin="round"/><path d="M196 82 Q206 52 230 40 Q222 70 198 96Z" fill="#f4ecd8" stroke="#b9ab88" stroke-width="3" stroke-linejoin="round"/>
 <path d="M54 90 C54 34 202 34 202 90Z" fill="#9aa6b5" stroke="#5f6b7a" stroke-width="3"/><rect x="50" y="84" width="156" height="14" rx="7" fill="#c9a227"/><rect x="122" y="44" width="12" height="44" fill="#c9a227"/>
 <circle cx="72" cy="91" r="3" fill="#7a5c10"/><circle cx="100" cy="91" r="3" fill="#7a5c10"/><circle cx="156" cy="91" r="3" fill="#7a5c10"/><circle cx="184" cy="91" r="3" fill="#7a5c10"/>`},
  wizard: {back:`<path d="M66 150 Q48 200 74 228 L182 228 Q208 200 190 150Z" fill="#2b3a8c"/>`,
 acc:`<path d="M128 -6 Q150 30 196 90 L60 90 Q100 40 128 -6Z" fill="#2b3a8c" stroke="#1a2563" stroke-width="3" stroke-linejoin="round"/><path d="M40 92 Q128 70 216 92 Q128 104 40 92Z" fill="#1a2563"/>
 <path d="M118 40 l4 -9 l4 9 l9 4 l-9 4 l-4 9 l-4 -9 l-9 -4Z" fill="#ffd23f"/><circle cx="146" cy="66" r="4" fill="#ffd23f"/><circle cx="104" cy="70" r="3" fill="#fff"/><path d="M160 46 a8 8 0 1 0 6 11 a6 6 0 1 1 -6 -11Z" fill="#ffd23f"/>
 <path d="M206 140 L232 196" stroke="#7a4a24" stroke-width="6" stroke-linecap="round"/><circle cx="204" cy="136" r="9" fill="#9be7ff"/><circle cx="201" cy="133" r="3" fill="#fff"/>`},
  cowboy: {body:`<path d="M90 168 L128 196 L166 168 Q128 178 90 168Z" fill="#e5383b"/><circle cx="110" cy="176" r="2.5" fill="#fff"/><circle cx="128" cy="184" r="2.5" fill="#fff"/><circle cx="146" cy="176" r="2.5" fill="#fff"/>`,
 acc:`<path d="M30 76 Q40 92 128 92 Q216 92 226 76 Q216 64 196 72 Q128 82 60 72 Q40 64 30 76Z" fill="#a0652e" stroke="#6e4019" stroke-width="3"/>
 <path d="M72 76 Q72 22 100 24 Q114 36 128 30 Q142 36 156 24 Q184 22 184 76 Q128 86 72 76Z" fill="#b8763a" stroke="#6e4019" stroke-width="3"/><path d="M74 68 Q128 78 182 68" stroke="#3a2418" stroke-width="7" fill="none"/>`},
  chef: {body:`<path d="M78 172 Q128 160 178 172 L178 202 Q128 214 78 202Z" fill="#fff" stroke="#dfe4ea" stroke-width="2"/><path d="M116 168 L128 184 L140 168" fill="#e5383b"/><circle cx="128" cy="194" r="3" fill="#9aa6b5"/>`,
 acc:`<path d="M80 84 L80 54 Q60 50 62 32 Q66 12 90 18 Q98 0 128 2 Q158 0 166 18 Q190 12 194 32 Q196 50 176 54 L176 84Z" fill="#fff" stroke="#dfe4ea" stroke-width="3"/><rect x="78" y="70" width="100" height="16" rx="4" fill="#f4f6f9" stroke="#dfe4ea" stroke-width="2"/>
 <path d="M104 30 Q110 44 106 56 M152 30 Q146 44 150 56" stroke="#e6e9ee" stroke-width="3" fill="none"/>`},
  ninja: {body:`<path d="M80 172 Q128 152 176 172 L176 200 Q128 214 80 200Z" fill="#23262e"/><rect x="80" y="182" width="96" height="8" fill="#e5383b"/>`,
 acc:`<path d="M48 84 Q128 62 208 84 L208 98 Q128 76 48 98Z" fill="#e5383b"/><path d="M206 88 Q228 90 236 74 M206 94 Q230 102 240 92" stroke="#e5383b" stroke-width="8" fill="none" stroke-linecap="round"/>
 <path d="M52 124 Q90 112 128 128 Q166 112 204 124 C200 152 170 166 128 166 C86 166 56 152 52 124Z" fill="#23262e"/><path d="M84 140 Q128 128 172 140" stroke="#3a3f4a" stroke-width="3" fill="none"/>`},
  rally: {body:`<path d="M80 172 Q128 152 176 172 L176 200 Q128 214 80 200Z" fill="#1d4ed8"/><path d="M104 166 L118 210 M138 166 L152 210" stroke="#fff" stroke-width="6"/>`,
 acc:`<path d="M46 110 C40 30 216 30 210 110 L196 110 C190 80 66 80 60 110Z" fill="#fff" stroke="#c6ced8" stroke-width="3"/><path d="M70 60 Q128 30 186 60" stroke="#1d4ed8" stroke-width="10" fill="none" stroke-linecap="round"/><path d="M90 48 Q128 34 166 48" stroke="#e5383b" stroke-width="5" fill="none"/>
 <path d="M64 86 Q128 68 192 86 L188 100 Q128 84 68 100Z" fill="#1d2a3d" opacity=".85"/><path d="M78 88 l20 -4" stroke="#fff" stroke-width="3" opacity=".6" stroke-linecap="round"/>
 <rect x="22" y="40" width="34" height="26" rx="4" fill="#fff" stroke="#1d2a3d" stroke-width="2.5"/><path d="M25 43 h7 v7 h-7z M39 43 h7 v7 h-7z M32 50 h7 v7 h-7z M46 50 h7 v7 h-7z M25 57 h7 v7 h-7z M39 57 h7 v7 h-7z" fill="#1d2a3d"/>`},
  rainbow: {fur:['#ff5fa2','#6c5ce7'],line:'#4b2fb0',belly:'#fff4fb',ear:'#3a1e8a',hub:'#2ee6c5',iris:'#7c3aed',acc:`<path d="M30 50 l5 -12 l5 12 l12 5 l-12 5 l-5 12 l-5 -12 l-12 -5Z" fill="#ffd23f"/><path d="M212 160 l4 -9 l4 9 l9 4 l-9 4 l-4 9 l-4 -9 l-9 -4Z" fill="#2ee6c5"/><circle cx="216" cy="40" r="5" fill="#ff5fa2"/>`}
};

// Shop image: the fox alone.
function skinShopSvg(id) {
  const art = SKIN_ART[id];
  return art ? foxSvg(art).replace('viewBox="0 0 256 256" width="256" height="256"', 'viewBox="0 -8 256 264" width="256" height="264"') : '';
}
// Map image (static file): the fox upright with a small arrow below it pointing north.
// On the live map the arrow is a separate element rotated to the driving direction (see presence.js).
function skinMapSvg(id) {
  const fox = skinShopSvg(id);
  if (!fox) return '';
  const inner = fox.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return `<svg viewBox="0 0 256 320" width="256" height="320" xmlns="http://www.w3.org/2000/svg">
<g transform="translate(0 8)">${inner}</g>${SKIN_ARROW_SVG.replace(/^<svg[^>]*>/, '<g transform="translate(98 260)">').replace(/<\/svg>$/, '</g>')}</svg>`;
}
// Heading arrow (60 × 60), points up.
const SKIN_ARROW_SVG = '<svg viewBox="0 0 60 60" width="60" height="60" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M30 4 52 54 30 42 8 54Z" fill="#1e5bb8" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>';

const skinUrlCache = new Map();
// data: URL of a skin's shop image (cached) — used for <img> in the Garage and on the map.
function skinDataUrl(id) {
  if (!skinUrlCache.has(id)) {
    const svg = skinShopSvg(id);
    skinUrlCache.set(id, svg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : '');
  }
  return skinUrlCache.get(id);
}
function skinArrowUrl() { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SKIN_ARROW_SVG); }

// Rarity tier by price (same rule as the generated column public.skins.rarity).
function skinRarity(price) { return price >= 600 ? 'epic' : price >= 400 ? 'rare' : 'common'; }
const SKIN_RARITY_LABEL = { common: 'Parasts', rare: 'Rets', epic: 'Episks' };

// Fallback catalogue (the server list wins when available).
const SKINS_DEFAULT = [
  { id: 'chef', name: 'Pavārs', price: 200 }, { id: 'cowboy', name: 'Kovbojs', price: 300 },
  { id: 'pilot', name: 'Pilots', price: 350 }, { id: 'viking', name: 'Vikings', price: 400 },
  { id: 'ninja', name: 'Ninja', price: 450 }, { id: 'wizard', name: 'Burvis', price: 500 },
  { id: 'rally', name: 'Rallijs', price: 600 }, { id: 'rainbow', name: 'Varavīksne', price: 800 },
].map(s => ({ ...s, rarity: skinRarity(s.price) }));

if (typeof module !== 'undefined') {
  module.exports = { foxSvg, SKIN_ART, skinShopSvg, skinMapSvg, skinDataUrl, skinArrowUrl, skinRarity, SKIN_RARITY_LABEL, SKINS_DEFAULT, SKIN_ARROW_SVG };
}
