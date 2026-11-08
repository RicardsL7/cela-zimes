// A10: MapLibre no lietotnes pašas mapes (vendor/, versija un SHA-256 — vendor/vendor.lock), nevis no unpkg CDN:
// lapa neizpilda nevienu svešu JavaScript, un kartes worker ir no tās pašas adreses (CSP worker-src 'self').
// ES modulis (<script type="module">) uzliek window.maplibregl; pārējie skripti ir defer un izpildās pēc šī — dokumenta secībā.
import * as maplibregl from './vendor/maplibre-gl-6.15.0/maplibre-gl.mjs';
window.maplibregl = maplibregl;
