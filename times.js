// Laika ierobežojumi zīmēm ("P–Pk 7–19", "22–7", "XII–II").
// Laiki nāk no OpenStreetMap (opening_hours pieraksts), piem.
//   "Mo-Fr 07:00-19:00", "(22:00-07:00)", "Dec-Feb", "Sa,Su 08:00-14:00; PH off".
// parseCondition() atgriež { test(date) → true/false/null, short, long }.

const OH_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];          // Date.getDay() kārtībā
const OH_DAY_LV = { Mo: 'P', Tu: 'O', We: 'T', Th: 'C', Fr: 'Pk', Sa: 'S', Su: 'Sv' };
const OH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OH_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const OH_MONTH_LV = ['janv.', 'febr.', 'marts', 'apr.', 'maijs', 'jūn.', 'jūl.', 'aug.', 'sept.', 'okt.', 'nov.', 'dec.'];
const OH_FULL_DAY = { Monday: 'Mo', Tuesday: 'Tu', Wednesday: 'We', Thursday: 'Th', Friday: 'Fr', Saturday: 'Sa', Sunday: 'Su' };

function ohMinutes(h, m) { return Number(h) * 60 + Number(m); }
function ohTimeShort(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
}
function ohTimeLong(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Viens noteikums, piem. "Mo-Fr 07:00-19:00" → { months, days, times, off, ok }
function parseOhRule(text) {
  const r = { months: null, days: null, times: [], off: /\boff\b|\bclosed\b/.test(text), ok: false, daysText: [], monthsText: [] };
  const MON = OH_MONTHS.join('|'), DAY = OH_DAYS.join('|');
  for (const m of text.matchAll(new RegExp(`\\b(${MON})\\b(?:\\s*-\\s*(${MON})\\b)?`, 'g'))) {
    const a = OH_MONTHS.indexOf(m[1]), b = m[2] ? OH_MONTHS.indexOf(m[2]) : a;
    r.months = r.months || new Set();
    for (let i = a; ; i = (i + 1) % 12) { r.months.add(i); if (i === b) break; }
    r.monthsText.push(OH_ROMAN[a] + (m[2] ? '–' + OH_ROMAN[b] : ''));
    (r.monthsLong = r.monthsLong || []).push(OH_MONTH_LV[a] + (m[2] ? '–' + OH_MONTH_LV[b] : ''));
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
    r.times.push([ohMinutes(m[1], m[2]), ohMinutes(m[3], m[4])]);
    r.ok = true;
  }
  if (/\bPH\b/.test(text) && !r.days && !r.times.length && !r.months) r.ok = false; // tikai svētku dienas — nezinām
  return r;
}

function ohRuleMatches(r, d) {
  if (r.months && !r.months.has(d.getMonth())) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  let day = d.getDay();
  if (r.times.length) {
    let inTime = false;
    for (const [a, b] of r.times) {
      if (a <= b ? (t >= a && t < b) : (t >= a || t < b)) {
        inTime = true;
        // Pāri pusnaktij (22–7): rīta daļa pieder iepriekšējai dienai.
        if (a > b && t < b) day = (day + 6) % 7;
        break;
      }
    }
    if (!inTime) return false;
  }
  if (r.days && !r.days.has(day)) return false;
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

function ohRuleLabel(r, long) {
  const parts = [];
  if (r.monthsText.length) parts.push(long ? r.monthsLong.join(', ') : r.monthsText.join(','));
  if (r.daysText.length) parts.push(ohDaysLabel(r.daysText, long));
  if (r.times.length) parts.push(r.times.map(([a, b]) => long ? `${ohTimeLong(a)}–${ohTimeLong(b)}` : `${ohTimeShort(a)}–${ohTimeShort(b)}`).join(', '));
  return parts.join(' ');
}

// Nosacījums (bez vērtības), piem. "(Mo-Fr 07:00-19:00)" vai "Dec-Feb".
function parseCondition(raw) {
  let text = String(raw || '').trim().replace(/^\(|\)$/g, '').trim();
  // "... AND weight>7.5" u.c.: ņem tikai laika daļu.
  text = text.split(/\s+AND\s+/i).find(p => /\d:\d\d|\b(Mo|Tu|We|Th|Fr|Sa|Su|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(p)) || '';
  const rules = text.split(/\s*;\s*|\s*\|\|\s*/).filter(Boolean).map(parseOhRule).filter(r => r.ok);
  if (!rules.length) return { test: () => null, short: '', long: String(raw || '').replace(/[()]/g, ''), simpleTime: null };
  const on = rules.filter(r => !r.off), off = rules.filter(r => r.off);
  const test = d => on.some(r => ohRuleMatches(r, d)) && !off.some(r => ohRuleMatches(r, d));
  const one = on.length === 1 && !off.length && !on[0].months && !on[0].days && on[0].times.length === 1 ? on[0].times[0] : null;
  return {
    test,
    short: on.map(r => ohRuleLabel(r, false)).join('; '),
    long: on.map(r => ohRuleLabel(r, true)).join('; '),
    simpleTime: one,   // [no, līdz] minūtēs, ja tas ir tikai viens laika posms
  };
}

// Apgriež nosacījumu: aizliegums spēkā VISU laiku, IZŅEMOT norādīto.
function invertCondition(c) {
  if (c.simpleTime) {
    const [a, b] = c.simpleTime;
    return { test: d => { const v = c.test(d); return v == null ? null : !v; },
      short: `${ohTimeShort(b)}–${ohTimeShort(a)}`, long: `${ohTimeLong(b)}–${ohTimeLong(a)}`, simpleTime: [b, a] };
  }
  return { test: d => { const v = c.test(d); return v == null ? null : !v; },
    short: 'izņ. ' + c.short, long: 'visu laiku, izņemot ' + c.long, simpleTime: null };
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
  module.exports = { parseCondition, invertCondition, splitConditional, legacyCondition };
}
