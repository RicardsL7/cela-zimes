// Ceļa Zīmes — index-gl.html → galvenā lapa (B16, audits 2). Saglabā ?parametrus un #daļu (pieteikšanās, maksājuma
// atgriešanās u.c.), aizstāj vēsturē (poga „Atpakaļ” neatgriežas uz pāradresāciju).
function czRedirectTarget(loc) {
  return loc.pathname.replace(/index-gl\.html$/, '') + (loc.search || '') + (loc.hash || '');
}
if (typeof location !== 'undefined' && /index-gl\.html$/.test(location.pathname)) location.replace(czRedirectTarget(location));
if (typeof module !== 'undefined') module.exports = { czRedirectTarget };
