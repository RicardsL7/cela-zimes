// Kopbraucienu serveris (Supabase). Abas vērtības ir publiskas (paredzētas lapai) —
// drošību nodrošina datubāzes noteikumi (supabase/rides.sql). Tukšas → demo režīms (tikai šajā ierīcē).
// NEKAD šeit neliec "secret" / "service_role" atslēgu.
const RIDES_CONFIG = {
  url: 'https://pkqusuoicxmwcgwsrdqy.supabase.co',
  anonKey: 'sb_publishable_cL4eCL_RyUVwzlYdX5Vu_A_P9udXgrk',
  // B07: Cloudflare Turnstile publiskā „Site Key” (nav noslēpums). Tukša → bez CAPTCHA. Ieslēgšanas secība: vispirms šeit
  // (lietotne sāk sūtīt žetonu), TAD Supabase → Authentication → Attack Protection → CAPTCHA (Turnstile + Secret Key).
  captchaSiteKey: '',
};
