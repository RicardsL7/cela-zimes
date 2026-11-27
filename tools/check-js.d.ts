// B16: globālie nosaukumi, ko tools/check-js.mjs nevar redzēt no klasiskajiem skriptiem.
declare var maplibregl: any;                       // maplibre-load.js (ES modulis) → window.maplibregl
declare var Capacitor: any;                        // Android lietotne (Capacitor tilts)
declare function skinArtSvg(id: string): string;   // skins-art.js (IIFE → root.skinArtSvg)
declare var module: any;                           // `if (typeof module !== 'undefined')` — testiem (Node)
declare function require(name: string): any;
interface Window { [key: string]: any }
