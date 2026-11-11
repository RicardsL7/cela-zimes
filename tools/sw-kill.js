// B14 — AVĀRIJAS izslēgšana bezsaistes režīmam. Lieto tikai, ja sw.js rada problēmas (piem. lietotājiem rāda vecu versiju).
// KĀ: šī faila saturu ieliec sw.js vietā (tas pats nosaukums, sakne) un izvieto. Pārlūki pie nākamās lapas atvēršanas
// ielādē šo versiju: tā izdzēš sw.js kešus (cz-shell/data/tiles; cache.js un mapillary.js kešus neaiztiek) un noņem sevi.
// Šajā failā nav fetch apstrādes — visi pieprasījumi iet tīklā (kā pirms B14). Lapas NEpārlādē (pwa.js katrā atvēršanā to
// reģistrē no jauna, un tas atkal tikai noņem sevi — bez pārlādēm cilpā). Atjaunot: atpakaļ īsto sw.js no git.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', ev => ev.waitUntil((async () => {
  for (const k of await caches.keys()) if (/^cz-(shell|data|tiles)-v\d+$/.test(k)) await caches.delete(k);
  await self.registration.unregister();
})()));
