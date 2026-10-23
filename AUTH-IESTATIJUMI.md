# Ceļa Zīmes — konti (F1): iestatījumi un uzturēšana

## Kas jau ir izdarīts (23.10.2026.)
- Supabase → Authentication → URL Configuration:
  - **Site URL:** `https://ricardsl7.github.io/cela-zimes/`
  - **Redirect URLs:** `https://ricardsl7.github.io/cela-zimes/**`, `http://localhost:*/**`
- Supabase → Authentication → Sign In / Providers: **Allow manual linking — ieslēgts** (anonīmam kontam var piesaistīt Google), **Allow anonymous sign-ins — ieslēgts** (kā līdz šim).
- SQL `supabase/rides-7-account.sql` — palaists (piekrišanas, datu pārcelšana, konta dzēšana).
- Servera funkcija `ride-pay` — izvietota ar jaunajām darbībām `close` (Stripe konta slēgšana, dzēšot kontu) un `adopt` (Stripe konta piesaiste pēc kontu apvienošanas).

## Vēl jāizdara īpašniekam

### 1. Vārds un e-pasts noteikumos
`terms.html` un `privacy.html` — aizstāt visus **[AIZPILDĪT]** (vārds, uzvārds, kontakta e-pasts). Ieteicams noteikumus parādīt juristam.

### 2. E-pasta sūtīšana visiem lietotājiem (pirms publiskošanas)
Supabase iebūvētais e-pasts sūta tikai projekta komandas adresēm un tikai dažas vēstules stundā — derīgs testiem.
Īstiem lietotājiem: Supabase → Project Settings → Authentication → **SMTP Settings** → Enable custom SMTP.
Piemēram, Resend vai Brevo: tur apstiprina savu domēnu (DNS ieraksti), izveido SMTP paroli un to ievada **pats** Supabase SMTP iestatījumos.
Pēc tam Authentication → Rate Limits — palielināt e-pastu limitu.

Neobligāti: Authentication → Emails → veidnes „Magic Link” un „Change Email Address” — latviski, piemēram:
- Temats: `Ceļa Zīmes — pieslēgšanās saite`
- Teksts: `Lai pieslēgtos Ceļa Zīmēm, nospied saiti: {{ .ConfirmationURL }} (der 1 stundu). Ja to nepieprasīji — ignorē šo vēstuli.`

### 3. Google pieslēgšanās
Poga „Turpināt ar Google” lietotnē parādās **automātiski**, tiklīdz Google ir ieslēgts Supabase.
1. https://console.cloud.google.com → izveido projektu → APIs & Services → **OAuth consent screen**: External, lietotnes nosaukums „Ceļa Zīmes”, atbalsta e-pasts, saites uz `…/privacy.html` un `…/terms.html`.
2. APIs & Services → **Credentials** → Create credentials → OAuth client ID → Web application.
   - Authorized JavaScript origins: `https://ricardsl7.github.io`
   - Authorized redirect URIs: `https://pkqusuoicxmwcgwsrdqy.supabase.co/auth/v1/callback`
3. Nokopē **Client ID** un **Client secret** → Supabase → Authentication → Sign In / Providers → **Google** → Enable → ielīmē abus (to dara īpašnieks pats) → Save.

### 4. Apple pieslēgšanās (ja vajadzēs)
Vajag Apple Developer kontu (~99 $ gadā). Kods to atbalsta tāpat kā Google (provider `apple`), poga vēl nav pievienota.

## Kā darbojas
- Atverot lietotni — piekrišanas ekrāns (noteikumi + privātums, versija `2026-10-23`). Bez piekrišanas lietotne nedarbojas; GPS netiek ieslēgts, konts netiek veidots.
- Konts (anonīms) tiek izveidots tikai, atverot „Kopā” vai ieslēdzot ātruma dalīšanu. Esoša sesija tikai tiek atjaunota.
- „Kopā” → „Saglabāt kontu” → e-pasts → saite. Lietotāja ID nemainās, dati paliek.
- Ja e-pasts jau pieder citam kontam → „Pieslēgties un pārcelt”: anonīmais konts saņem vienreizēju kodu (2 h), pēc pieslēgšanās dati tiek pārcelti, anonīmais konts dzēsts. Ja neizdodas — „Atgriezties pie iepriekšējā konta”.
- „Dzēst kontu”: Stripe šofera konts tiek slēgts (`ride-pay close`), tad `delete_my_account()` dzēš lietotāju un kaskādē visus viņa datus. Ja Stripe kontu neizdevās slēgt — tas tiek ierakstīts tabulā `account_closures` (Stripe panelī jāslēdz manuāli).
- Piekrišanas tiek glabātas `user_consents` (veids, versija, laiks); ātruma dalīšanai — atsevišķs ieraksts `speed_share`.

## Noderīgi SQL (Supabase → SQL Editor)
```sql
-- Stripe konti, kas jāslēdz manuāli
select * from account_closures order by requested_at desc;
-- Piekrišanas pēdējās 24 h
select kind, version, accepted, count(*) from user_consents where created_at > now() - interval '1 day' group by 1,2,3;
```
