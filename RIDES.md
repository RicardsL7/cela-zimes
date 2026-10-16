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

## Vēl nav (nākamie soļi)

Vērtējumi pēc brauciena, ziņošana par lietotāju, čats aplikācijā, push paziņojumi, kad lapa ir
aizvērta, un brauciena kopīgošana ar tuviniekiem.
