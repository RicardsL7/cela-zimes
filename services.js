// B04: visu ārējo karšu servisu adreses vienā vietā.
// Šobrīd — bezmaksas publiskie serveri (lietotne nav komerciāla: bez maksas, maksājumi tikai testa režīmā).
// Pirms īstajiem maksājumiem (PAY_LIVE — lietotne kļūst komerciāla) šeit nomaina adreses uz maksas vai savu serveri;
// citur kodā nekas nav jāmaina. Plāns un cenas — README „Ārējie servisi: pāreja uz komerciālu lietošanu”.
// Ja maina serveri (host), tam jābūt arī index.html / index-gl.html CSP connect-src un netguard.js CZ_NET_POLICY.
const CZ_SERVICES = {
  // Maršruts automašīnai (OSRM API). Pirmais — galvenais; ja tas neatbild, saka „par daudz” vai ir pauzē pēc kļūmes
  // (netguard), lietotne jautā nākamajam. Abu noteikumi: ≤ 1 pieprasījums sekundē, bez masveida lietošanas,
  // atsauce uz OSM (iestatījumos „Par lietotni”). Maksas variants: GraphHopper / Stadia Maps vai savs OSRM.
  route: [
    'https://router.project-osrm.org/route/v1/driving/',
    'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
  ],
  // Maršruts kājāmgājējam (OSRM API, FOSSGIS)
  routeFoot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
  // Meklēšana: Photon (rakstot) un Nominatim (rezerve, tikai nospiežot „Meklēt” — Nominatim noteikumi)
  photon: 'https://photon.komoot.io',
  nominatim: 'https://nominatim.openstreetmap.org',
  // Ielu dati, zīmes, vietas (Overpass). B05: tikai ES serveris — overpass-api.de (FOSSGIS, Vācija). Agrākā rezerve
  // maps.mail.ru (VK, Krievija) izņemta: atrašanās vietas vaicājumi nedrīkst iet uz valsti bez ES pietiekamības lēmuma.
  // Ja vajag rezervi vai lielu apjomu — savs Overpass serveris (README „Ārējie servisi”), to pievieno šim sarakstam.
  overpass: ['https://overpass-api.de/api/interpreter'],
  // Laikapstākļi. Bezmaksas Open-Meteo — tikai nekomerciālai lietošanai. Komerciāli: Supabase funkcija „weather”
  // (supabase/functions/weather — Open-Meteo atslēga tikai Supabase Secrets, nekad šeit), t.i.
  //   weather: 'https://pkqusuoicxmwcgwsrdqy.supabase.co/functions/v1/weather'
  weather: 'https://api.open-meteo.com/v1/forecast',
};

function czServiceHost(url) { const m = /^https?:\/\/([^/?#]+)/.exec(String(url)); return m ? m[1].toLowerCase() : ''; }
// Vai adrese ir mūsu Supabase funkcija (tad pieprasījumam vajag publisko anon atslēgu galvenē)
function czServiceIsOwn(url) { return /\.supabase\.co\/functions\/v1\//.test(url); }
// Serveru secība: pēc kārtas, bet tie, kam netguard pašlaik ir pauze pēc kļūmes, — beigās
function czServiceOrder(urls) {
  // czNetCooling — netguard.js funkcija (window.czNet citos skriptos aizsedz netguard.js iekšējais const czNet)
  const cooling = u => typeof czNetCooling === 'function' && czNetCooling(czServiceHost(u));
  return urls.filter(u => !cooling(u)).concat(urls.filter(u => cooling(u)));
}

if (typeof module !== 'undefined') module.exports = { CZ_SERVICES, czServiceHost, czServiceIsOwn, czServiceOrder };
