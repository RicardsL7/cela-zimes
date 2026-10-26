# Braukt kopā (kopbraucieni)

Poga **"Kopā"** labajā pogu kolonnā atver logu ar divām cilnēm:

* **Man vajag aizbraukt** — pasažieris norāda: no kurienes (pēc noklusējuma mana vieta), uz kurieni,
  kad un cik cilvēku. Pēc tam publicē pieprasījumu un redz šoferu piedāvājumus: vārdu, auto un pēc
  cik minūtēm šoferis var būt klāt. Pasažieris pieņem vienu piedāvājumu, un tad abi redz viens otra
  tālruni ("Zvanīt").
* **Es braucu, varu paņemt** — šoferis redz cilvēkus, kuri gaida braucienu:
  * ja ir izvēlēts galamērķis, tikai tos, kuru sākums un galamērķis ir ≤ 800 m no viņa maršruta, tajā
    pašā virzienā un vēl priekšā. Saraksts sakārtots pēc tā, kurš pirmais pa ceļam, un pie katra
    norādīts aptuvens apkārtceļš minūtēs;
  * bez galamērķa — cilvēkus 5 km rādiusā.

  Šoferis spiež "Paņemšu". Kad pasažieris piedāvājumu pieņem, šoferis spiež "Braukt pakaļ", un
  navigācija ved līdz pasažierim.

Jaunumi (piedāvājums, pieņemts vai noraidīts) pārbaudīti ik 15 s. Ja logs ir aizvērts, uz pogas
parādās sarkans punkts un telefons novibrē.

Naudu aplikācija neapstrādā. Izmaksas var sadalīt savā starpā (pārvadājumiem par maksu vajag licenci).

## Čats un brauciena gaita

* **Čats**: pie katra piedāvājuma (gan gaidoša, gan pieņemta) ir poga "Čats" ar nelasīto ziņu skaitu. Ir
  ātrās atbildes ("Esmu ceļā", "Esmu klāt" …). Ziņas redz tikai abi dalībnieki. Jaunas ziņas tiek
  pārbaudītas ik 4–5 s.
* **Šofera soļi**: "Braukt pakaļ" (sāk navigāciju līdz pasažierim un dalās ar savu atrašanās vietu) →
  "Esmu klāt" → "Pasažieris iekāpa" (navigācija uz pasažiera galamērķi) → "Brauciens pabeigts".
* **Pasažieris** redz statusu ("Šoferis brauc pie tevis · 1,2 km · ~4 min", "Šoferis ir klāt!" — telefons
  novibrē) un kartē zaļu auto. Redzams arī maršruts: kamēr šoferis brauc pakaļ — līdz
  pasažierim, pēc tam — līdz galamērķim, ar ierašanās laiku.
* **Šoferis** kartē redz, kur pasažieris gaida (ja pasažieris dalās ar atrašanās vietu).
* Atrašanās vietas tiek sūtītas tikai pieņemtam braucienam: šoferim ik ~5 s pēc "Braukt pakaļ",
  pasažierim ik ~15 s, līdz viņš iekāpj.

Datubāzes daļa: `supabase/rides-2-chat-trip.sql`. Brauciena gaitu var mainīt tikai šoferis, un tikai caur
drošām funkcijām.

## Pēc brauciena: kopsavilkums, vērtējums, ziņošana (F13)

* Kad šoferis nospiež **„Brauciens pabeigts”**, abi (pasažieris cilnē „Man vajag aizbraukt”, šoferis cilnē
  „Es braucu”) augšā redz **kopsavilkumu**: maršruts, datums un laiks, otras puses vārds un auto, cena un
  maksājuma statuss („Samaksāts ar karti” / „↩ Atmaksāts …” / „Skaidrā naudā vai nav samaksāts”).
  Kartīte rādās, kamēr to aizver (×), nospiež „Izlaist” vai novērtē (aizvērtās — `localStorage`
  `cz.rides.summarySeen`, pēdējās 50). Pēc 3 dienām tā vairs pati neparādās — novērtēt var „Mani braucienos”.
* **Vērtējums**: 1–5 zvaigznes (lielas pogas ar `aria-label` „3 zvaigznes no 5”) + neobligāts komentārs
  līdz 200 zīmēm. Pasažieris vērtē šoferi, šoferis — pasažieri. Katrs vienu reizi par braucienu; mainīt vai
  dzēst nevar. Vērtēt var tikai pabeigtu braucienu.
* **Vidējais vērtējums** („★ 4,7 · 12 braucieni” vai „Vēl nav vērtējumu”) redzams: šofera piedāvājumā, ko
  redz pasažieris, saskaņotā brauciena kartītē, šofera sarakstā pie pasažiera, konta skatā un „Mani braucienos”.
  Atsevišķus komentārus citi neredz.
* **„Ziņot par problēmu”** (kopsavilkumā un vēsturē, arī par atceltu braucienu): „Bīstama braukšana”,
  „Neatbilstoša uzvedība”, „Neieradās”, „Problēma ar maksājumu”, „Cits” + apraksts līdz 500 zīmēm.
  Ziņojumu redz tikai pats ziņotājs un lietotnes īpašnieks (Supabase → Table editor → `user_reports`);
  otrs lietotājs — nē. Ne vairāk kā 10 ziņojumi dienā.
* **„Mani braucieni”** (saite joslā loga augšā un konta skatā): pabeigtie un atceltie braucieni abās lomās,
  jaunākie augšā — datums, maršruts, loma, statuss, cena un samaksa, mans vērtējums. Pieskaroties —
  kopsavilkums, „Novērtēt” (ja vēl nav) un „Ziņot par problēmu”.

Datubāze: `supabase/rides-9-ratings.sql` — tabulas `ride_ratings` un `user_reports` (nosaukums `reports` jau
aizņemts ceļa ziņojumiem), funkcijas `rating_summary(ids)` un `my_ride_history(lim)`. Kuru vērtē / par kuru
ziņo, aizpilda datubāze pati (klienta vērtībai netic). Konta pārcelšana (F1) pārceļ arī vērtējumus un
ziņojumus; konta dzēšana dzēš savus vērtējumus un ziņojumus (ziņojumi par dzēsto lietotāju paliek anonīmi).

## Serveris (Supabase)

Kamēr `rides-config.js` ir tukšs, viss darbojas **demo režīmā**: dati glabājas tikai šajā ierīcē, un
ar pogu "+ testa pasažieris" var izmēģināt šofera pusi.

Kopīgai darbībai:

1. Supabase → **SQL Editor** → New query → ielīmē visu `supabase/rides.sql` → **Run**.
2. **Authentication → Sign In / Providers → Allow anonymous sign-ins: ON.** Lietotājiem nav jāreģistrējas;
   katrs telefons saņem savu anonīmo kontu.
3. **Project Settings → API**: nokopē **Project URL** un **anon public** (vai "publishable") atslēgu un
   ieliec tās `rides-config.js`. Abas vērtības ir publiskas un paredzētas lapai. **Service role / secret**
   atslēgu lapā likt nedrīkst nekad.

## Drošība (RLS noteikumi)

* Profilu (vārdu, auto) redz pieteikušies lietotāji. Mainīt drīkst tikai savu profilu.
* **Tālruni** redz tikai pats īpašnieks un tas, ar kuru brauciens ir saskaņots.
* Atvērtos pieprasījumus redz visi. Pēc saskaņošanas tos redz tikai pasažieris un viņa šoferis.
* Piedāvājumu var nosūtīt tikai atvērtam pieprasījumam, un ne savam. Šoferis var tikai atcelt
  piedāvājumu, pasažieris var to pieņemt vai noraidīt.
* Vienam lietotājam vienlaikus var būt ne vairāk kā 5 aktīvi pieprasījumi (pret mēstulēm).
* Vērtēt un ziņot var tikai brauciena dalībnieks un tikai par otru pusi; vērtējumu — tikai pēc pabeigta brauciena.

## Vēl nav (nākamie soļi)

Push paziņojumi, kad lapa ir aizvērta, un brauciena kopīgošana ar tuviniekiem.
