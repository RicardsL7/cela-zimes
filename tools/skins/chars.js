// Ceļa Zīmes — "Garāža" characters (bear, cat, panda, penguin, owl, bunny, raccoon). Build: node tools/skins/build.js
// Base characters as functions of a palette, so mythic skins can recolour everything.
// Palette: fur[2], line, belly, dark (markings), inner (ear inside), iris, hub, nose, glowEyes

function eyesStd(p) {
  return [-1, 1].map(s => `<ellipse cx="${128 + s * 31}" cy="108" rx="15" ry="18" fill="url(#ce)"/><ellipse cx="${128 + s * 31 + 5}" cy="101" rx="5.5" ry="6.5" fill="#fff"/><circle cx="${128 + s * 31 - 5}" cy="115" r="2.6" fill="#fff" opacity=".8"/>`).join('');
}
function noseStd(p) {
  return `<path d="M118 132 Q128 126 138 132 Q136 142 128 143 Q120 142 118 132Z" fill="${p.nose || '#1d1513'}"/><ellipse cx="124" cy="132" rx="3.5" ry="2" fill="#fff" opacity=".6"/>
<path d="M128 143 L128 148 M114 147 Q121 156 128 148 Q135 156 142 147" stroke="#1d1513" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}
const HEAD = l => `<path d="M128 46 C70 46 46 80 48 116 C50 150 84 166 128 166 C172 166 206 150 208 116 C210 80 186 46 128 46Z" fill="url(#cf)" stroke="${l}" stroke-width="3.5"/>`;
const roundEars = (c, i, l) => `<circle cx="70" cy="62" r="26" fill="${c}" stroke="${l}" stroke-width="3.5"/><circle cx="186" cy="62" r="26" fill="${c}" stroke="${l}" stroke-width="3.5"/><circle cx="70" cy="62" r="13" fill="${i}"/><circle cx="186" cy="62" r="13" fill="${i}"/>`;

const CHARS = {
  bear: { name: 'Lācis', pal: { fur: ['#b07a4c', '#7d4e2a'], line: '#4e2e14', belly: '#f3dfc4', inner: '#e8c49c', hub: '#ffb547' },
    parts: p => ({ ears: roundEars('url(#cf)', p.inner, p.line) }) },
  cat: { name: 'Kaķis', pal: { fur: ['#a9b4c2', '#7b8696'], line: '#4a5361', belly: '#f4f6f9', inner: '#ffb3c1', dark: '#5c6675', iris: '#2f8f4e', hub: '#5ec8ff', nose: '#ff8fa3' },
    parts: p => ({
      ears: `<path d="M56 96 L54 34 L104 62Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5" stroke-linejoin="round"/><path d="M200 96 L202 34 L152 62Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5" stroke-linejoin="round"/><path d="M64 80 L62 48 L90 64Z" fill="${p.inner}"/><path d="M192 80 L194 48 L166 64Z" fill="${p.inner}"/>`,
      mask: `<path d="M112 52 Q128 58 144 52 M108 64 Q128 72 148 64 M118 76 Q128 80 138 76" stroke="${p.dark}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
      nose: `<path d="M121 131 L135 131 L128 139Z" fill="${p.nose}"/><path d="M128 139 L128 144 M117 146 Q122 152 128 144 Q134 152 139 146" stroke="#1d1513" stroke-width="3.4" fill="none" stroke-linecap="round"/><path d="M60 128 H36 M62 138 H38 M196 128 H220 M194 138 H218" stroke="${p.line}" stroke-width="2.5" stroke-linecap="round"/>`,
      back: `<path d="M170 196 Q226 196 214 140 Q210 126 220 116" stroke="${p.line}" stroke-width="20" fill="none" stroke-linecap="round"/><path d="M170 196 Q226 196 214 140 Q210 126 220 116" stroke="url(#cf)" stroke-width="13" fill="none" stroke-linecap="round"/>`,
    }) },
  panda: { name: 'Panda', pal: { fur: ['#ffffff', '#e9edf2'], line: '#2b2f36', belly: '#ffffff', dark: '#23262e', inner: '#3a3f4a', hub: '#7ed957' },
    parts: p => ({
      ears: roundEars(p.dark, p.inner, p.dark),
      mask: `<ellipse cx="97" cy="110" rx="22" ry="26" fill="${p.dark}" transform="rotate(-20 97 110)"/><ellipse cx="159" cy="110" rx="22" ry="26" fill="${p.dark}" transform="rotate(20 159 110)"/>`,
      body: `<path d="M80 172 Q128 152 176 172 L176 200 Q128 214 80 200Z" fill="${p.dark}"/>`,
    }) },
  penguin: { name: 'Pingvīns', pal: { fur: ['#2d3a55', '#1b2336'], line: '#0f1626', belly: '#ffffff', iris: '#2a2a2a', hub: '#5ec8ff', beak: '#ffa62b' },
    parts: p => ({
      head: `<path d="M128 44 C66 44 44 80 46 118 C48 152 84 168 128 168 C172 168 208 152 210 118 C212 80 190 44 128 44Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5"/><path d="M62 112 C62 86 92 74 128 92 C164 74 194 86 194 112 C194 146 166 162 128 162 C90 162 62 146 62 112Z" fill="${p.belly}"/>`,
      nose: `<path d="M114 128 Q128 120 142 128 Q128 146 114 128Z" fill="${p.beak}" stroke="#c06a00" stroke-width="2.5"/>`,
    }) },
  owl: { name: 'Pūce', pal: { fur: ['#a07850', '#6e4c2c'], line: '#43291a', belly: '#f6e7cf', iris: '#d98a00', hub: '#9b7cff', beak: '#ffb02e' },
    parts: p => ({
      ears: `<path d="M58 84 L62 30 L98 56Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5" stroke-linejoin="round"/><path d="M198 84 L194 30 L158 56Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5" stroke-linejoin="round"/>`,
      mask: `<circle cx="97" cy="108" r="30" fill="${p.belly}"/><circle cx="159" cy="108" r="30" fill="${p.belly}"/>`,
      eyes: [97, 159].map(x => `<circle cx="${x}" cy="108" r="18" fill="url(#ce)"/><circle cx="${x + 5}" cy="101" r="6" fill="#fff"/><circle cx="${x - 5}" cy="115" r="2.6" fill="#fff" opacity=".8"/>`).join(''),
      nose: `<path d="M120 128 L136 128 L128 144Z" fill="${p.beak}" stroke="#c07000" stroke-width="2.5" stroke-linejoin="round"/>`, cheeks: false,
      body: `<path d="M100 178 q8 -6 14 0 q6 -6 14 0 q6 -6 14 0 q6 -6 14 0" stroke="${p.line}" opacity=".35" stroke-width="3" fill="none"/>`,
    }) },
  bunny: { name: 'Zaķis', pal: { fur: ['#ffffff', '#e8ecf1'], line: '#9aa6b5', belly: '#ffffff', inner: '#ffc2d1', iris: '#5a2a3a', hub: '#ff8a2a', nose: '#ff8fa3' },
    parts: p => ({
      ears: `<path d="M86 66 C70 10 82 -4 96 -2 C112 2 112 30 106 62Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5"/><path d="M170 66 C186 10 174 -4 160 -2 C144 2 144 30 150 62Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5"/><path d="M92 58 C84 22 90 10 96 10 C104 12 104 34 100 58Z" fill="${p.inner}"/><path d="M164 58 C172 22 166 10 160 10 C152 12 152 34 156 58Z" fill="${p.inner}"/>`,
      nose: `<path d="M122 130 Q128 126 134 130 Q132 137 128 137 Q124 137 122 130Z" fill="${p.nose}"/><path d="M128 137 L128 143 M118 145 Q123 150 128 143 Q133 150 138 145" stroke="#6b5560" stroke-width="3.2" fill="none" stroke-linecap="round"/><rect x="122" y="146" width="12" height="9" rx="2" fill="#fff" stroke="${p.line}" stroke-width="2"/>`,
    }) },
  raccoon: { name: 'Jenots', pal: { fur: ['#9aa3ad', '#6a737e'], line: '#353b44', belly: '#eef1f5', dark: '#2b2f36', inner: '#f1f3f6', hub: '#ffd23f' },
    parts: p => ({
      back: `<path d="M168 186 Q222 182 220 140 Q218 116 200 112 Q206 140 186 156 Q170 166 160 170Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5"/><path d="M204 118 l14 6 M212 136 l8 2 M206 156 l10 -6" stroke="${p.dark}" stroke-width="8" stroke-linecap="round"/>`,
      ears: `<path d="M58 92 Q52 44 74 34 Q96 46 104 66Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5" stroke-linejoin="round"/><path d="M198 92 Q204 44 182 34 Q160 46 152 66Z" fill="url(#cf)" stroke="${p.line}" stroke-width="3.5" stroke-linejoin="round"/><path d="M68 76 Q66 54 76 46 Q90 54 94 66Z" fill="${p.inner}"/><path d="M188 76 Q190 54 180 46 Q166 54 162 66Z" fill="${p.inner}"/>`,
      mask: `<path d="M54 102 Q90 86 128 108 Q166 86 202 102 Q196 128 166 130 Q146 128 128 116 Q110 128 90 130 Q60 128 54 102Z" fill="${p.dark}"/><path d="M50 122 Q86 110 128 134 Q170 110 206 122 C202 150 170 166 128 166 C86 166 54 150 50 122Z" fill="${p.belly}"/>`,
    }) },
};

// Assemble one skin. c = costume { back, body, face, acc, pal (overrides), aura, fx }
function draw(charId, c = {}) {
  const ch = CHARS[charId];
  const p = Object.assign({}, ch.pal, c.pal || {});
  const P = ch.parts(p);
  const line = p.line;
  const glow = c.glowEyes ? `<filter id="cg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>` : '';
  const eyes = P.eyes || eyesStd(p);
  return `<svg viewBox="0 -8 256 264" width="256" height="264" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="cf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.fur[0]}"/><stop offset="1" stop-color="${p.fur[1]}"/></linearGradient>
<radialGradient id="ce" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="${p.iris || '#4a2a18'}"/><stop offset="1" stop-color="${p.irisOut || '#14100e'}"/></radialGradient>
<radialGradient id="ca" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${c.aura || '#fff'}" stop-opacity=".75"/><stop offset=".6" stop-color="${c.aura || '#fff'}" stop-opacity=".25"/><stop offset="1" stop-color="${c.aura || '#fff'}" stop-opacity="0"/></radialGradient>${glow}${c.defs || ''}</defs>
${c.aura ? `<circle cx="128" cy="128" r="128" fill="url(#ca)"/>` : ''}
<ellipse cx="128" cy="238" rx="66" ry="7" fill="#000" opacity=".15"/>
${c.back || ''}${P.back || ''}
<ellipse cx="128" cy="186" rx="50" ry="32" fill="url(#cf)" stroke="${line}" stroke-width="3.5"/>
<ellipse cx="128" cy="192" rx="28" ry="20" fill="${p.belly}"/>
${c.noBaseBody ? '' : P.body || ''}${c.body || ''}
${[94, 162].map(x => `<circle cx="${x}" cy="216" r="19" fill="${p.tyre || '#1f242c'}"/><circle cx="${x}" cy="216" r="9" fill="${p.hub || '#ff8a2a'}"/><circle cx="${x}" cy="216" r="3.5" fill="${p.tyre || '#1f242c'}"/><path d="M${x - 12} 210 a14 14 0 0 1 10 -9" stroke="#fff" stroke-width="3" opacity=".25" fill="none" stroke-linecap="round"/>`).join('')}
${c.behindHead || ''}${P.ears || ''}
${P.head || HEAD(line)}
${P.mask || ''}${c.mask || ''}
${eyes}${c.glowEyes ? `<g filter="url(#cg)" opacity=".9">${[97, 159].map(x => `<circle cx="${x}" cy="108" r="12" fill="${c.glowEyes}"/>`).join('')}</g>` : ''}
${P.nose || noseStd(p)}
${P.cheeks === false || c.noCheeks ? '' : `<ellipse cx="80" cy="134" rx="11" ry="7" fill="${p.cheek || '#ff7c7c'}" opacity=".45"/><ellipse cx="176" cy="134" rx="11" ry="7" fill="${p.cheek || '#ff7c7c'}" opacity=".45"/>`}
${c.face || ''}${c.acc || ''}${c.fx || ''}</svg>`;
}
module.exports = { CHARS, draw };
