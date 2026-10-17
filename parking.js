// „Vai drīkstu šeit stāvēt?” — lēmuma loģika (bez kartes; pārbaudāma ar testiem).
//
// Lietotne (app-gl.js) savāc kontekstu ap mašīnu:
//   • zīmes uz TĀ PAŠA ceļa, TAJĀ PAŠĀ braukšanas virzienā un TAJĀ PAŠĀ ceļa pusē, aiz mašīnas
//     līdz tuvākajam krustojumam (326./327. zīmes darbojas no zīmes līdz krustojumam);
//   • OpenStreetMap ielas stāvēšanas atzīmes (parking:left/right/both:…), stāvlaukumu, kurā mašīna ir;
//   • tuvos objektus, kam Ceļu satiksmes noteikumos (MK Nr. 279) ir attāluma aizliegumi.
// Šeit no tā visa top atbilde: drīkst / drīkst ar nosacījumiem / nedrīkst / nevar pārbaudīt,
// līdz kuram laikam, kāpēc un cik drošs ir secinājums. Nezināmo NEIZDOMĀ — par to brīdina.

const PK_T = typeof parseCondition === 'function'
  ? { parseCondition, splitConditional }
  : require('./times.js');

const PK_CAR_HALF = 2.3;          // no tālruņa (mašīnas vidus) līdz buferim, m
const PK_JUNCTION_EDGE = 4;       // krustojuma centrs → šķērsojamās brauktuves mala, m (aptuveni)
const PK_HORIZON = 8 * 864e5;     // cik tālu nākotnē meklē nākamo maiņu

// ---------- Zīmju veidi ----------
// Mapillary kods → stāvēšanai nozīmīgais veids (vai null).
function parkSignKind(value) {
  const v = String(value || '');
  if (/bicycles|motorcycles/.test(v)) return null;                          // ne vieglajām mašīnām
  if (/end-of-(no-)?(parking|stopping)(?!-zone)|end-of-prohibition/.test(v)) return 'end';
  if (/end-of-parking-zone/.test(v)) return 'zone-end';
  if (/no-parking-or-no-stopping/.test(v)) return 'no-parking';            // abos gadījumos stāvēt aizliegts
  if (/--no-stopping--/.test(v)) return 'no-stopping';
  if (/--no-parking--/.test(v)) return 'no-parking';
  if (/tow-away/.test(v)) return 'tow';
  if (/^information--(parking|parallel-parking)/.test(v)) return 'parking';
  if (/bus-stop|tram-stop|trolleybus-stop/.test(v)) return 'stop';
  if (/pedestrians?-crossing|crosswalk/.test(v)) return 'crossing';
  return null;
}
const PK_SIGN_NAME = { 'no-stopping': 'Apstāties aizliegts', 'no-parking': 'Stāvēt aizliegts', end: 'Aizlieguma beigas',
  parking: 'Stāvvieta', 'zone-end': 'Zonas beigas', tow: 'Evakuācijas zona', stop: 'Pietura' };

// ---------- Laiks (vienmēr Latvijas laikā) ----------
let pkFmt = null;
function pkParts(d) {
  if (!pkFmt) pkFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Riga', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = {}; for (const x of pkFmt.formatToParts(d)) p[x.type] = x.value;
  return { day: p.year + p.month + p.day, hm: p.hour + ':' + p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const PK_DAYS_ON = ['svētdien', 'pirmdien', 'otrdien', 'trešdien', 'ceturtdien', 'piektdien', 'sestdien'];
// "22:00" · "rīt 07:00" · "pirmdien 08:00"
function pkWhen(t, now) {
  const a = pkParts(now), b = pkParts(t), tom = pkParts(new Date(now.getTime() + 864e5));
  if (b.day === a.day) return b.hm;
  if (b.day === tom.day) return b.hm === '00:00' ? '24:00' : 'rīt ' + b.hm;
  return PK_DAYS_ON[b.dow] + ' ' + b.hm;
}
// "3 h 10 min" · "25 min" · "2 d 4 h"
function pkDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return Math.floor(h / 24) + ' d' + (h % 24 ? ' ' + (h % 24) + ' h' : '');
}
// Nākamā brīža, kad test() maina vērtību (līdz 8 dienām): 5 min solis, tad precīzi līdz minūtei.
function pkNextChange(test, now) {
  const t0 = Math.floor(now.getTime() / 60000) * 60000, STEP = 5 * 60000, cur = !!test(new Date(t0));
  for (let t = t0 + STEP; t <= t0 + PK_HORIZON; t += STEP) {
    if (!!test(new Date(t)) === cur) continue;
    let a = t - STEP, b = t;                      // a — vēl vecais stāvoklis, b — jau jaunais
    while (b - a > 60000) {
      const m = a + Math.max(1, Math.floor((b - a) / 120000)) * 60000;
      if (!!test(new Date(m)) === cur) a = m; else b = m;
    }
    return new Date(b);
  }
  return null;
}
// "2 hours", "90 min", "2h", "1:30" → ms
function pkMaxstay(v) {
  const s = String(v || '').trim().toLowerCase();
  let m;
  if ((m = /^(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hour|hours|st|stundas?)$/.exec(s))) return parseFloat(m[1].replace(',', '.')) * 3600e3;
  if ((m = /^(\d+)\s*(min|mins|minute|minutes|minūtes?)$/.exec(s))) return +m[1] * 60e3;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) return (+m[1] * 60 + +m[2]) * 60e3;
  if ((m = /^(\d+)\s*(d|day|days)$/.exec(s))) return +m[1] * 864e5;
  return null;
}

// ---------- OpenStreetMap ielas stāvēšanas atzīmes ----------
// side — 'left' | 'right' attiecībā pret OSM ceļa līnijas virzienu.
// → { restrict: { kind, test|null, label } | null, fee: { test|null, label } | null, maxstay, access, raw } vai null
function parkOsmSide(tags, side) {
  const t = tags || {}, g = k => t[`parking:${side}:${k}`] ?? t[`parking:both:${k}`];
  const out = { restrict: null, fee: null, maxstay: null, access: null };
  const KIND = { no_stopping: 'no-stopping', no_parking: 'no-parking', no_standing: 'no-parking', fire_lane: 'no-stopping' };
  const cond = raw => { const c = PK_T.parseCondition(raw); return c.known ? c : null; };
  // Jaunā shēma: parking:<puse>:restriction (+ :conditional)
  let base = g('restriction'), bc = g('restriction:conditional');
  // Vecā shēma: parking:condition:<puse> / parking:lane:<puse>
  const oldC = t[`parking:condition:${side}`] ?? t['parking:condition:both'];
  const oldL = t[`parking:lane:${side}`] ?? t['parking:lane:both'];
  if (!base && KIND[oldC]) base = oldC;
  if (!base && KIND[oldL]) base = oldL;
  if (!bc) { const ti = t[`parking:condition:${side}:time_interval`] ?? t['parking:condition:both:time_interval']; if (ti && KIND[oldC]) { bc = oldC + ' @ (' + ti + ')'; base = null; } }
  const parts = bc ? PK_T.splitConditional(bc) : [];
  if (KIND[base]) {
    const exc = parts.filter(p => p.value === 'none' || p.value === 'no').map(p => cond(p.cond)).filter(Boolean);
    out.restrict = exc.length
      ? { kind: KIND[base], test: d => !exc.some(c => c.test(d)), label: 'izņemot ' + exc.map(c => c.ui).join('; ') }
      : { kind: KIND[base], test: null, label: '' };
  } else {
    const on = parts.filter(p => KIND[p.value]).map(p => ({ k: KIND[p.value], c: cond(p.cond) })).filter(x => x.c);
    if (on.length) out.restrict = { kind: on.some(x => x.k === 'no-stopping') ? 'no-stopping' : 'no-parking',
      test: d => on.some(x => x.c.test(d)), label: on.map(x => x.c.ui).join('; ') };
  }
  // Maksa
  const fee = g('fee'), fc = g('fee:conditional');
  if (fc) {
    const yes = PK_T.splitConditional(fc).filter(p => p.value === 'yes').map(p => cond(p.cond)).filter(Boolean);
    if (yes.length) out.fee = { test: d => yes.some(c => c.test(d)), label: yes.map(c => c.ui).join('; ') };
  }
  if (!out.fee && (fee === 'yes' || oldC === 'ticket' || oldC === 'disc')) out.fee = { test: null, label: '' };
  out.maxstay = pkMaxstay(g('maxstay') ?? t[`parking:condition:${side}:maxstay`] ?? t['parking:condition:both:maxstay']);
  out.access = g('access') || (/^(residents|customers|private)$/.test(oldC || '') ? oldC : null);
  return out.restrict || out.fee || out.maxstay || out.access ? out : null;
}

// ---------- Lēmums ----------
// ctx = {
//   area:  stāvlaukums, kurā mašīna atrodas: { name, access, fee, feeCond, oh, maxstay } | null,
//   signs: [{ kind, at, cond, timeUnknown, sure, tow, title, ref }]   at < 0 — aiz mašīnas (m), > 0 — priekšā,
//   osm:   parkOsmSide() rezultāts | null,
//   near:  { crossingAt, junctionAhead, junctionBehind, stopAhead, stopBehind, railM, bridge, tunnel },
//   acc, roadKnown, dirKnown, mly (Mapillary zīmes šai vietai ielādētas), osmOk (OSM vaicājums izdevās)
// }
function parkVerdict(ctx, now = new Date()) {
  const R = [];                   // iemesli: { level: 'no'|'warn'|'info'|'ok', text, detail, src, ref }
  const bans = [];                // { test|null (vienmēr), why }
  const fees = [];
  let maxstay = null, unknownTime = false;
  const maybe = [];               // nedroši piesaistīti laika aizliegumi — tikai brīdinājumam un atgādinājumam
  const acc = Math.min(25, Math.max(4, ctx.acc || 10));
  const signs = (ctx.signs || []).slice().sort((a, b) => b.at - a.at);   // tuvākā aiz mašīnas — pirmā
  const inArea = !!ctx.area && !ctx.area.guess;
  if (ctx.area && ctx.area.guess) R.push({ level: 'info', text: `Tuvumā ir stāvlaukums${ctx.area.name ? ' „' + ctx.area.name + '”' : ''}`, detail: 'Ja mašīna ir stāvlaukumā, noteicošas ir tā zīmes (maksa, laiks, tikai klientiem).', src: 'karte' });

  const addBan = (kind, test, label, src, ref, sure = true, timeUnknown = false) => {
    const name = PK_SIGN_NAME[kind] || 'Stāvēt aizliegts';
    if (timeUnknown) {
      unknownTime = true;
      R.push({ level: 'warn', text: `${name} — zem zīmes ir laika plāksnīte, bet laiks nav nolasīts`, detail: 'Paskaties foto vai plāksnīti uz vietas.', src, ref });
      return;
    }
    const on = test ? !!test(now) : true;
    if (!sure) {
      if (test) maybe.push(test);
      R.push({ level: on ? 'warn' : 'info', text: `${name}${label ? ' · ' + label : ''}${on ? ' — iespējams, attiecas uz tavu vietu' : ' — šobrīd nav spēkā'}`,
        detail: 'Nav droši zināms, vai zīme attiecas uz šo ielas pusi.', src, ref });
      return;
    }
    bans.push({ test, kind });
    R.push({ level: on ? 'no' : 'info', hard: !test, text: `${name}${label ? ' · ' + label : test ? '' : ' visu diennakti'}${test ? (on ? ' — tagad ir spēkā' : ' — tagad nav spēkā') : ''}`, src, ref });
  };

  if (inArea) {
    const a = ctx.area;
    R.push({ level: 'ok', text: `Tu esi stāvlaukumā${a.name ? ' „' + a.name + '”' : ''}`, src: 'OpenStreetMap' });
    if (/^(private|no)$/.test(a.access || '')) R.push({ level: 'no', hard: true, text: 'Privāts stāvlaukums — svešiem stāvēt nedrīkst', src: 'OpenStreetMap' });
    else if (/^(customers|permissive|destination)$/.test(a.access || '')) R.push({ level: 'warn', text: a.access === 'customers' ? 'Tikai klientiem' : 'Ierobežota piekļuve', src: 'OpenStreetMap' });
    else if (/^(residents|permit)$/.test(a.access || '')) R.push({ level: 'warn', text: 'Tikai iedzīvotājiem vai ar atļauju', src: 'OpenStreetMap' });
    if (a.fee === 'yes' || a.feeCond) {
      const c = a.feeCond ? PK_T.parseCondition(a.feeCond) : null;
      fees.push({ test: c && c.known ? d => c.test(d) : null, label: c && c.known ? c.ui : '' });
    } else if (a.fee === 'no') R.push({ level: 'ok', text: 'Bezmaksas', src: 'OpenStreetMap' });
    if (a.oh) {
      const c = /^\s*24\/7\s*$/.test(a.oh) ? null : PK_T.parseCondition(a.oh);
      if (c && c.known) {
        const open = !!c.test(now);
        if (!open) R.push({ level: 'warn', text: 'Stāvlaukums šobrīd slēgts (' + c.ui + ')', src: 'OpenStreetMap' });
        else {
          bans.push({ test: d => !c.test(d), kind: 'closed' });
          R.push({ level: 'info', text: 'Darba laiks: ' + c.ui + ' — paspēj izbraukt, pirms slēdz', src: 'OpenStreetMap' });
        }
      }
    }
    if (a.maxstay) maxstay = a.maxstay;
  } else {
    // 1) Zīmes aiz mašīnas līdz krustojumam: katram veidam noteicošā ir tuvākā; aizlieguma beigu zīme to atceļ.
    const endAt = (signs.find(s => s.kind === 'end' && s.at <= 0) || { at: -Infinity }).at;
    const parkAt = (signs.find(s => s.kind === 'parking' && s.at <= 0 && s.sure !== false) || { at: -Infinity }).at;
    for (const kind of ['no-stopping', 'no-parking']) {
      // Noteicošā ir tuvākā DROŠI piesaistītā zīme; ja tādas nav — tuvākā nedrošā (tikai brīdinājums).
      const behind = signs.filter(x => x.kind === kind && x.at <= 0);
      const s = behind.find(x => x.sure !== false) || behind[0];
      if (!s) continue;
      if (endAt > s.at) {
        R.push({ level: 'ok', text: `„${PK_SIGN_NAME[kind]}” zona beigusies (${Math.round(-endAt)} m aiz tevis ir beigu zīme)`, src: 'Mapillary', ref: signs.find(x => x.kind === 'end' && x.at === endAt).ref });
        continue;
      }
      const label = s.cond ? s.cond.ui : '';
      // Stāvvietas zīme starp aizlieguma zīmi un mašīnu — šī vieta, visticamāk, ir atļauta stāvvieta.
      const sure = s.sure !== false && !(parkAt > s.at);
      addBan(kind, s.cond ? d => s.cond.test(d) : null, label, `zīme ${Math.round(-s.at)} m aiz tevis · Mapillary`, s.ref, sure, s.timeUnknown);
      if (parkAt > s.at) R.push({ level: 'info', text: `Pēc aizlieguma zīmes ir stāvvietas zīme (${Math.round(-parkAt)} m aiz tevis) — stāvvietā stāvēt drīkst`, src: 'Mapillary' });
      if (s.tow) R.push({ level: 'warn', text: 'Evakuācijas zona — mašīnu var aizvilkt', src: 'Mapillary', ref: s.ref });
    }
    // 2) Aizlieguma zīme tieši priekšā (GPS kļūdas robežās) — zona sākas pie zīmes.
    for (const s of signs) {
      if ((s.kind === 'no-stopping' || s.kind === 'no-parking') && s.at > 0 && s.at <= acc + PK_CAR_HALF + 3 && s.sure !== false) {
        const on = s.cond ? !!s.cond.test(now) : !s.timeUnknown;
        if (on || s.timeUnknown) R.push({ level: 'warn', text: `„${PK_SIGN_NAME[s.kind]}” zīme ~${Math.round(s.at)} m priekšā — novieto mašīnu PIRMS tās`, src: 'Mapillary', ref: s.ref });
        break;
      }
    }
    // 3) Stāvvietas zīme tuvumā
    const pz = signs.find(s => s.kind === 'parking' && s.at <= 15 && s.at >= -60);
    if (pz) R.push({ level: 'ok', text: `Stāvvietas zīme ${pz.at <= 0 ? Math.round(-pz.at) + ' m aiz tevis' : 'tuvumā'}${pz.cond ? ' · ' + pz.cond.ui : ''}`,
      detail: pz.timeUnknown ? 'Zem zīmes ir plāksnīte (laiks, maksa vai ilgums) — paskaties foto.' : '', src: 'Mapillary', ref: pz.ref });
    // 4) OpenStreetMap ielas atzīmes
    const o = ctx.osm;
    if (o) {
      if (o.restrict) addBan(o.restrict.kind, o.restrict.test, o.restrict.label, 'OpenStreetMap', null, true);
      if (o.fee) fees.push(o.fee);
      if (o.maxstay) maxstay = o.maxstay;
      if (o.access && /^(private|residents|permit|customers)$/.test(o.access))
        R.push({ level: 'warn', text: o.access === 'customers' ? 'Tikai klientiem' : 'Tikai iedzīvotājiem vai ar atļauju', src: 'OpenStreetMap' });
    }
    // 5) Ceļu satiksmes noteikumu attālumi (MK Nr. 279, 121.–122. p.)
    const n = ctx.near || {};
    const rule = (d, limit, textNo, textNear) => {
      if (d == null) return;
      const gap = d - PK_CAR_HALF;
      if (gap < limit - acc * 0.5 && acc <= 12) R.push({ level: 'no', hard: true, text: textNo(Math.max(0, Math.round(gap))), src: 'Ceļu satiksmes noteikumi' });
      else if (gap < limit + acc * 0.8) R.push({ level: 'warn', text: textNear(Math.max(0, Math.round(gap))), src: 'Ceļu satiksmes noteikumi' });
    };
    if (n.crossingAt != null && Math.abs(n.crossingAt) <= 3) R.push({ level: 'no', hard: true, text: 'Uz gājēju pārejas apstāties aizliegts (CSN 121.5)', src: 'Ceļu satiksmes noteikumi' });
    else if (n.crossingAt != null && n.crossingAt > 0) rule(n.crossingAt, 5,
      g => `Gājēju pāreja tikai ~${g} m priekšā — jābūt vismaz 5 m (CSN 121.5)`,
      g => `Gājēju pāreja ~${g} m priekšā — pārliecinies, ka līdz tai ir vismaz 5 m (CSN 121.5)`);
    for (const d of [n.junctionAhead, n.junctionBehind]) rule(d == null ? null : d - PK_JUNCTION_EDGE, 5,
      g => `Krustojums tikai ~${g} m attālumā — jābūt vismaz 5 m (CSN 121.6)`,
      g => `Krustojums tuvu (~${g} m) — jābūt vismaz 5 m no šķērsojamās brauktuves malas (CSN 121.6)`);
    rule(n.stopAhead, 25, g => `Sabiedriskā transporta pietura ~${g} m priekšā — jābūt vismaz 25 m (CSN 121.7)`,
      g => `Pietura ~${g} m priekšā — pirms pieturas jābūt vismaz 25 m (CSN 121.7)`);
    rule(n.stopBehind, 10, g => `Sabiedriskā transporta pietura ~${g} m aiz tevis — jābūt vismaz 10 m (CSN 121.7)`,
      g => `Pietura ~${g} m aiz tevis — aiz pieturas jābūt vismaz 10 m (CSN 121.7)`);
    if (n.railM != null && n.railM < 50) R.push({ level: n.railM < 50 - acc ? 'no' : 'warn', hard: true, text: `Dzelzceļa pārbrauktuve ~${Math.round(n.railM)} m — apdzīvotā vietā stāvēt tuvāk par 50 m aizliegts (CSN 122.1)`, src: 'Ceļu satiksmes noteikumi' });
    if (n.bridge) R.push({ level: 'no', hard: true, text: 'Uz tilta vai estakādes apstāties aizliegts (CSN 121.3)', src: 'OpenStreetMap' });
    if (n.tunnel) R.push({ level: 'no', hard: true, text: 'Tunelī apstāties aizliegts (CSN 121.2)', src: 'OpenStreetMap' });
  }

  // ---------- Kopsavilkums ----------
  const timed = bans.filter(b => b.test), always = bans.some(b => !b.test);
  const bannedAt = d => always || timed.some(b => b.test(d));
  const hardNo = R.some(r => r.level === 'no' && r.hard);
  const bannedNow = bans.length > 0 && bannedAt(now);
  let state, headline, sub = '', until = null, from = null, maybeUntil = null;
  const feeAt = d => fees.some(f => !f.test || f.test(d));

  if (!ctx.roadKnown && !inArea) {
    state = 'unknown'; headline = 'Nevar pārbaudīt';
    sub = 'Šai vietai vēl nav ielādēti ceļa dati. Pietuvini karti un mēģini vēlreiz.';
  } else if (hardNo || bannedNow || R.some(r => r.level === 'no')) {
    state = 'no';
    const stopBan = bans.some(b => b.kind === 'no-stopping' && (!b.test || b.test(now))) || R.some(r => r.level === 'no' && /apstāties aizliegts/i.test(r.text));
    headline = stopBan ? 'Apstāties aizliegts' : 'Nedrīksti stāvēt';
    if (!always && !hardNo && timed.length) {
      from = pkNextChange(bannedAt, now);
      if (from) sub = `Drīkstēs no ${pkWhen(from, now)} (pēc ${pkDur(from - now)})`;
    }
    const nr = R.find(r => r.level === 'no');
    if (!sub) sub = nr.ref && nr.hard && /zīme/.test(nr.src || '') ? 'Visu diennakti · ' + nr.src.replace(/ · Mapillary$/, '') + ' (līdz krustojumam)' : nr.text;
  } else {
    if (timed.length) until = pkNextChange(bannedAt, now);
    const ms = maxstay ? new Date(now.getTime() + maxstay) : null;
    if (ms && (!until || ms < until)) until = ms;
    if (maybe.length) {
      const mu = pkNextChange(d => maybe.some(t => t(d)), now);
      if (mu && !maybe.some(t => t(now)) && (!until || mu < until)) {
        R.unshift({ level: 'warn', text: `Iespējams, no ${pkWhen(mu, now)} te stāvēt nedrīkst — pārbaudi zīmi`, src: 'zīmes laiks' });
        maybeUntil = mu;
      }
    }
    const warns = R.filter(r => r.level === 'warn');
    const paidNow = fees.length && feeAt(now);
    state = warns.length || paidNow || unknownTime ? 'warn' : 'ok';
    headline = paidNow ? 'Drīkst, bet par maksu' : warns.length ? 'Drīksti, bet pārbaudi' : 'Drīksti stāvēt';
    if (until) sub = `līdz ${pkWhen(until, now)} · vēl ${pkDur(until - now)}`;
    else if (maybeUntil) sub = `iespējams, līdz ${pkWhen(maybeUntil, now)} · pārbaudi zīmi`;
    else if (warns.length) sub = warns[0].text;
    else sub = 'Bez laika ierobežojuma';
    if (ms && until && +until === +ms) R.push({ level: 'warn', text: `Maksimālais stāvēšanas laiks ${pkDur(maxstay)}`, src: 'OpenStreetMap' });
    if (paidNow) {
      const f = fees.find(x => !x.test || x.test(now));
      const end = fees.every(x => x.test) ? pkNextChange(feeAt, now) : null;
      R.unshift({ level: 'warn', text: 'Maksas stāvēšana' + (f.label ? ' · ' + f.label : '') + (end ? ` — bez maksas no ${pkWhen(end, now)}` : ''), detail: 'Samaksā ar stāvvietas automātu vai lietotni.', src: 'OpenStreetMap' });
    } else if (fees.length) {
      const start = pkNextChange(feeAt, now);
      if (start) R.push({ level: 'info', text: `Šobrīd bez maksas, maksa sāksies ${pkWhen(start, now)}`, src: 'OpenStreetMap' });
    }
    if (until && timed.length && (!ms || +until !== +ms)) R.unshift({ level: until - now < 3600e3 ? 'warn' : 'info',
      text: `No ${pkWhen(until, now)} te stāvēt būs aizliegts`, src: 'zīmes laiks' });
    if (until && until - now < 3600e3 && state === 'ok') state = 'warn';
  }
  if (state !== 'unknown' && !R.length) R.push({ level: 'ok', text: inArea ? 'Stāvlaukums' : 'Aizlieguma zīmes un noteikumu pārkāpumi tuvumā nav atrasti', src: '' });

  // ---------- Cik droši ----------
  const why = [];
  let score = 3;
  if (!inArea && !ctx.mly) { score -= 2; why.push('ceļa zīmju foto dati šai vietai nav ielādēti'); }
  if (!inArea && !ctx.dirKnown) { score -= 1; why.push('mašīnas virziens nav zināms'); }
  if ((ctx.acc || 10) > 20) { score -= 1; why.push(`GPS precizitāte ±${Math.round(ctx.acc)} m`); }
  if (unknownTime) { score -= 1; why.push('laika plāksnīte nav nolasīta'); }
  if (!ctx.osmOk) { score -= 1; why.push('OpenStreetMap dati nav ielādēti'); }
  if (R.some(r => /iespējams, attiecas/.test(r.text))) { score -= 1; why.push('zīmes piederība ielas pusei nav droša'); }
  const confidence = score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low';
  const remindBase = until || maybeUntil;
  const remindAt = remindBase ? new Date(remindBase.getTime() - (remindBase - now > 40 * 60000 ? 15 : 5) * 60000) : null;
  const order = { no: 0, warn: 1, ok: 2, info: 3 };
  R.sort((a, b) => order[a.level] - order[b.level]);
  return { state, headline, sub, until: until || maybeUntil, from, remindAt: remindAt && remindAt > now ? remindAt : null, reasons: R, confidence,
    confidenceText: { high: 'Pārliecība: augsta', medium: 'Pārliecība: vidēja', low: 'Pārliecība: zema' }[confidence] + (why.length ? ' — ' + why.join(', ') : ''),
    proof: (R.find(r => r.ref && (r.level === 'no' || r.level === 'warn')) || R.find(r => r.ref) || {}).ref || null };
}

// ---------- Kalendāra notikums (.ics) atgādinājumam ----------
// RFC 5545: rindas ne garākas par 75 baitiem (UTF-8) — garākas pārnes ar atstarpi nākamās sākumā.
function pkFold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = ch.codePointAt(0) < 0x80 ? 1 : ch.codePointAt(0) < 0x800 ? 2 : ch.codePointAt(0) < 0x10000 ? 3 : 4;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function parkIcs({ start, end, title, text, lat, lng, alarmMin = 0, uid }) {
  const f = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cela Zimes//Stavvieta//LV', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', 'UID:' + (uid || f(start) + '@cela-zimes'), 'DTSTAMP:' + f(new Date()),
    'DTSTART:' + f(start), 'DTEND:' + f(end || new Date(start.getTime() + 15 * 60000)),
    'SUMMARY:' + esc(title), 'DESCRIPTION:' + esc(text),
    lat != null ? 'GEO:' + lat.toFixed(6) + ';' + lng.toFixed(6) : null,
    lat != null ? 'LOCATION:' + esc(`https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=18/${lat.toFixed(6)}/${lng.toFixed(6)}`) : null,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(title), 'TRIGGER:-PT' + alarmMin + 'M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).map(pkFold).join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined') {
  module.exports = { parkSignKind, parkOsmSide, parkVerdict, pkNextChange, pkWhen, pkDur, pkMaxstay, parkIcs };
}
