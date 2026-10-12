// Ierobežojumu darbības laiki ("P–Pk · 06:00–22:00", "22:00–07:00", "XII–II").
// Avots — OpenStreetMap opening_hours pieraksts, piem.
//   "Mo-Fr 07:00-19:00", "(22:00-07:00)", "Dec-Feb", "Sa,Su 08:00-14:00; PH off".
// Laiku VIENMĒR vērtē pēc Latvijas laika (Europe/Riga), neatkarīgi no telefona
// laika joslas, un ņem vērā Latvijas svētku dienas (PH).
// parseCondition() → { known, test(date) → true/false/null, short, long, rules, simpleTime }

const TZ = 'Europe/Riga';
const OH_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];          // Date.getDay() kārtībā
const OH_DAY_LV = { Mo: 'P', Tu: 'O', We: 'T', Th: 'C', Fr: 'Pk', Sa: 'S', Su: 'Sv' };
const OH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OH_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const OH_MONTH_LV = ['janv.', 'febr.', 'marts', 'apr.', 'maijs', 'jūn.', 'jūl.', 'aug.', 'sept.', 'okt.', 'nov.', 'dec.'];
const OH_FULL_DAY = { Monday: 'Mo', Tuesday: 'Tu', Wednesday: 'We', Thursday: 'Th', Friday: 'Fr', Saturday: 'Sa', Sunday: 'Su' };

// ---------- Latvijas laiks ----------
let rigaFmt = null;
function rigaParts(date) {
  if (!rigaFmt) {
    rigaFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  }
  const p = {};
  for (const x of rigaFmt.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month - 1, d: +p.day, min: (+p.hour % 24) * 60 + +p.minute,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

// ---------- Latvijas svētku dienas ----------
function easterSunday(y) {  // Gausa/Meeusa algoritms (Gregora kalendārs)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month - 1, day];
}
const lvHolidayCache = new Map();
function lvHolidays(y) {
  if (lvHolidayCache.has(y)) return lvHolidayCache.get(y);
  const set = new Set();
  const add = (mo, d) => set.add(mo * 100 + d);
  const addDate = dt => add(dt.getUTCMonth(), dt.getUTCDate());
  [[0, 1], [4, 1], [4, 4], [5, 23], [5, 24], [10, 18], [11, 24], [11, 25], [11, 26], [11, 31]].forEach(([m, d]) => add(m, d));
  const [em, ed] = easterSunday(y), easter = Date.UTC(y, em, ed);
  addDate(new Date(easter - 2 * 864e5));   // Lielā Piektdiena
  addDate(new Date(easter));               // Lieldienas
  addDate(new Date(easter + 864e5));       // Otrās Lieldienas
  // 4. maijs un 18. novembris brīvdienā → nākamā pirmdiena brīva.
  for (const [m, d] of [[4, 4], [10, 18]]) {
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    if (dow === 6) addDate(new Date(Date.UTC(y, m, d + 2)));
    if (dow === 0) addDate(new Date(Date.UTC(y, m, d + 1)));
  }
  lvHolidayCache.set(y, set);
  return set;
}
function isLvHoliday(y, mo, d) { return lvHolidays(y).has(mo * 100 + d); }

// ---------- Pieraksta lasīšana ----------
function ohMinutes(h, m) { return Number(h) * 60 + Number(m); }
function ohTimeShort(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
}
function ohTimeLong(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Viens noteikums, piem. "Mo-Fr 07:00-19:00" → { months, days, ph, times, off, ok }
function parseOhRule(text) {
  const r = { months: null, days: null, ph: /\bPH\b/.test(text), times: [], off: /\boff\b|\bclosed\b/.test(text),
    ok: false, daysText: [], monthsText: [], monthsLong: [] };
  const MON = OH_MONTHS.join('|'), DAY = OH_DAYS.join('|');
  for (const m of text.matchAll(new RegExp(`\\b(${MON})\\b(?:\\s*-\\s*(${MON})\\b)?`, 'g'))) {
    const a = OH_MONTHS.indexOf(m[1]), b = m[2] ? OH_MONTHS.indexOf(m[2]) : a;
    r.months = r.months || new Set();
    for (let i = a; ; i = (i + 1) % 12) { r.months.add(i); if (i === b) break; }
    r.monthsText.push(OH_ROMAN[a] + (m[2] ? '–' + OH_ROMAN[b] : ''));
    r.monthsLong.push(OH_MONTH_LV[a] + (m[2] ? '–' + OH_MONTH_LV[b] : ''));
    r.ok = true;
  }
  for (const m of text.matchAll(new RegExp(`\\b(${DAY})\\b(?:\\s*-\\s*(${DAY})\\b)?`, 'g'))) {
    const a = OH_DAYS.indexOf(m[1]), b = m[2] ? OH_DAYS.indexOf(m[2]) : a;
    r.days = r.days || new Set();
    for (let i = a; ; i = (i + 1) % 7) { r.days.add(i); if (i === b) break; }
    r.daysText.push([m[1], m[2]]);
    r.ok = true;
  }
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)) {
    r.times.push([ohMinutes(m[1], m[2]), ohMinutes(m[3], m[4]) % (24 * 60)]);   // "24:00" → 0 (pusnakts)
    r.ok = true;
  }
  if (r.ph) r.ok = true;
  return r;
}

// Vai noteikums darbojas šajā brīdī? p — rigaParts(date), prev — iepriekšējās dienas daļas.
function ohRuleMatches(r, p, prev) {
  let day = p;
  if (r.times.length) {
    let inTime = false;
    for (const [a, b] of r.times) {
      const t = p.min;
      if (a < b ? (t >= a && t < b) : a === b ? true : (t >= a || t < b)) {
        inTime = true;
        // Pāri pusnaktij (22–07): rīta daļa pieder iepriekšējai dienai.
        if (a > b && t < b) day = prev;
        break;
      }
    }
    if (!inTime) return false;
  }
  if (r.months && !r.months.has(day.mo)) return false;
  const hol = isLvHoliday(day.y, day.mo, day.d);
  if (r.days || r.ph) {
    const byDay = r.days ? r.days.has(day.dow) : false;
    if (!(byDay || (r.ph && hol))) return false;
  }
  return true;
}

function ohDaysLabel(pairs, long) {
  const key = pairs.map(p => p.filter(Boolean).join('-')).join(',');
  if (long) {
    if (key === 'Mo-Fr') return 'darbdienās';
    if (key === 'Sa-Su' || key === 'Sa,Su') return 'brīvdienās';
    if (key === 'Sa') return 'sestdienās';
    if (key === 'Su') return 'svētdienās';
  }
  return pairs.map(([a, b]) => OH_DAY_LV[a] + (b ? '–' + OH_DAY_LV[b] : '')).join(',');
}

// Teksts vienam noteikumam. style: 'short' (zem zīmes), 'long' (teikumā), 'ui' ("P–Pk · 06:00–22:00").
function ohRuleLabel(r, style) {
  const parts = [];
  if (r.monthsText.length) parts.push(style === 'short' ? r.monthsText.join(',') : r.monthsLong.join(', '));
  const days = [];
  if (r.daysText.length) days.push(ohDaysLabel(r.daysText, style === 'long'));
  if (r.ph) days.push(style === 'short' ? 'sv.d.' : 'svētku dienās');
  if (days.length) parts.push(days.join(', '));
  if (r.times.length) {
    parts.push(r.times.map(([a, b]) => style === 'short' ? `${ohTimeShort(a)}–${ohTimeShort(b)}` : `${ohTimeLong(a)}–${ohTimeLong(b)}`).join(', '));
  }
  return parts.join(style === 'ui' ? ' · ' : ' ');
}

// Nosacījums (bez vērtības), piem. "(Mo-Fr 07:00-19:00)" vai "Dec-Feb".
function parseCondition(raw) {
  let text = String(raw || '').trim().replace(/^\(|\)$/g, '').trim();
  // "... AND weight>7.5" u.c.: ņem tikai laika daļu, pārējo saglabā kā papildu nosacījumu.
  const pieces = text.split(/\s+AND\s+/i);
  const timePart = pieces.find(p => /\d:\d\d|\bPH\b|\b(Mo|Tu|We|Th|Fr|Sa|Su|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(p)) || '';
  const extra = pieces.filter(p => p !== timePart).join(' AND ');
  const rules = timePart.split(/\s*;\s*|\s*\|\|\s*/).filter(Boolean).map(parseOhRule).filter(r => r.ok);
  const unknown = { known: false, test: () => null, short: '', long: '', ui: '', rules: [], extra, raw: String(raw || ''), simpleTime: null };
  const on = rules.filter(r => !r.off), off = rules.filter(r => r.off);
  if (!on.length) return unknown;
  const test = date => {
    const p = rigaParts(date), prev = rigaParts(new Date(date.getTime() - 864e5));
    return on.some(r => ohRuleMatches(r, p, prev)) && !off.some(r => ohRuleMatches(r, p, prev));
  };
  const one = on.length === 1 && !off.length && !on[0].months && !on[0].days && !on[0].ph && on[0].times.length === 1 ? on[0].times[0] : null;
  const offText = off.length ? ' (izņemot ' + off.map(r => (r.ph && !r.days && !r.times.length && !r.months) ? 'svētku dienas' : (ohRuleLabel(r, 'long') || 'norādītās dienas')).join(', ') + ')' : '';
  return {
    known: true, test, extra, raw: String(raw || ''),
    short: on.map(r => ohRuleLabel(r, 'short')).join('; '),
    long: on.map(r => ohRuleLabel(r, 'long')).join('; ') + offText,
    ui: on.map(r => ohRuleLabel(r, 'ui')).join('; ') + offText,
    // Strukturēti dati (glabāšanai / pārbaudei)
    rules: rules.map(r => ({
      off: r.off, ph: r.ph,
      days: r.days ? [...r.days].sort().map(i => OH_DAYS[i]) : null,
      months: r.months ? [...r.months].sort((a, b) => a - b).map(i => OH_MONTHS[i]) : null,
      times: r.times.map(([a, b]) => ({ start: ohTimeLong(a), end: ohTimeLong(b) })),
    })),
    simpleTime: one,   // [no, līdz] minūtēs, ja tas ir tikai viens laika posms
  };
}

// Apgriež nosacījumu: aizliegums spēkā VISU laiku, IZŅEMOT norādīto.
function invertCondition(c) {
  if (!c.known) return c;
  const test = d => { const v = c.test(d); return v == null ? null : !v; };
  if (c.simpleTime) {
    const [a, b] = c.simpleTime;
    return Object.assign({}, c, { test, simpleTime: [b, a],
      short: `${ohTimeShort(b)}–${ohTimeShort(a)}`, long: `${ohTimeLong(b)}–${ohTimeLong(a)}`, ui: `${ohTimeLong(b)}–${ohTimeLong(a)}`,
      rules: [{ off: false, ph: false, days: null, months: null, times: [{ start: ohTimeLong(b), end: ohTimeLong(a) }] }] });
  }
  return Object.assign({}, c, { test, simpleTime: null,
    short: 'izņ. ' + c.short, long: 'visu laiku, izņemot ' + c.long, ui: 'izņemot ' + c.ui,
    rules: c.rules.map(r => Object.assign({}, r, { off: !r.off })) });
}

// "no @ (22:00-08:00); yes @ Su" → [{ value: 'no', cond: '(22:00-08:00)' }, ...]
function splitConditional(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(v)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(p => { const i = p.indexOf('@'); return i < 0 ? null : { value: p.slice(0, i).trim(), cond: p.slice(i + 1).trim() }; }).filter(Boolean);
}

// Vecais pieraksts: hour_on/hour_off, day_on/day_off.
function legacyCondition(tags) {
  const d1 = OH_FULL_DAY[tags.day_on] || '', d2 = OH_FULL_DAY[tags.day_off] || '';
  const days = d1 ? (d2 && d2 !== d1 ? `${d1}-${d2}` : d1) : '';
  const hours = tags.hour_on && tags.hour_off ? `${tags.hour_on}-${tags.hour_off}` : '';
  return (days + ' ' + hours).trim();
}

if (typeof module !== 'undefined') {
  module.exports = { parseCondition, invertCondition, splitConditional, legacyCondition, rigaParts, isLvHoliday, easterSunday };
}
