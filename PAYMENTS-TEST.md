# Kartes maksājumi — pārbaude Stripe testa režīmā (audits 2, B18)

Mērķis: pirms īstiem maksājumiem (`PAY_LIVE`) vienreiz no sākuma līdz beigām izmēģināt visu ceļu ar **īstu Stripe testa
režīmu** — šofera Connect konts, samaksa, atcelšana ar automātisko atmaksu, daļēja atmaksa, webhook atkārtojumi un strīds.
Testa režīmā īsta nauda netiek ņemta. Automātiskie testi (`tests/run.js` — ride-pay un stripe-webhook ar viltotu Stripe)
to neaizstāj: īstā Stripe uzvedas citādi (paraksti, Connect, atmaksas, strīdi).

**Kas vajadzīgs:** Stripe konts testa režīmā (Supabase Secrets: `STRIPE_SECRET_KEY` = `sk_test_…`, `STRIPE_WEBHOOK_SECRET`
= testa webhook `whsec_…`); divas ierīces vai pārlūki ar diviem testa kontiem lietotnē — **šoferis** un **pasažieris**
(piem. telefons un dators; nelieto kāda cita cilvēka kontu). Kartes numurus, paroles un bankas datus ievada tikai īpašnieks.

**Pārbaude datubāzē pēc katra soļa:** Supabase → SQL Editor → `tools/pay-check.sql` (visām „problēma:” rindām jābūt 0) un
`tools/pay-recent.sql` (pēdējie 20 maksājumi ar webhook notikumiem). Abi tikai lasa.

## 0. Sagatavošana

1. Lietotnē „Kopā” → kartes maksājumu blokā redzama zīme **TESTS** (atslēga ir `sk_test_`). Ja nav — maksājumi nav ieslēgti.
2. Stripe panelis (testa režīms) → Developers → Webhooks → galapunkts
   `https://pkqusuoicxmwcgwsrdqy.supabase.co/functions/v1/stripe-webhook` ar notikumiem:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired`, `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`,
   `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`,
   `charge.dispute.funds_reinstated`.
3. Izvietota jaunākā `stripe-webhook` (B18 — strīdu notikumi) — izdarīts 28.11.2026.

## 1.–12. Soļi

| # | Kas jādara | Kas jāredz |
|---|---|---|
| 1 | **Šoferis:** „Kopā” → „Es braucu” → „Pieslēgt maksājumus” → e-pasts → Stripe testa lapā aizpilda testa datus (Stripe piedāvā testa tālruni / kodu / kontu) | Atpakaļ lietotnē: „Pasažieri var tev samaksāt ar karti…”; Stripe → Connected accounts — jauns konts |
| 2 | **Pasažieris:** pieprasījums. **Šoferis:** piedāvājums ar cenu (piem. 5 €). **Pasažieris:** „Pieņemt” | Pasažierim poga „Maksāt ar karti” |
| 3 | **Pasažieris:** „Maksāt ar karti” → karte `4242 4242 4242 4242`, jebkurš nākotnes datums, jebkurš CVC | Abiem „✓ Samaksāts ar karti”; pay-recent: `paid`, webhook `checkout.session.completed → paid`; Stripe: maksājums 5 €, komisija 0,50 €, pārskaitījums šoferim 4,50 € |
| 4 | Stripe → šī maksājuma `checkout.session.completed` notikums → **Resend** | pay-recent: tas pats (atkārtots notikums neko nemaina); Stripe: 200 |
| 5 | **Pasažieris:** „Atcelt” (pirms iekāpšanas) | Automātiska atmaksa: „↩ Atmaksāts …”; pay-recent: `refunded`, iemesls `cancelled_before_pickup`, summa 500; Stripe: atmaksa, pārskaitījums un komisija atgriezti |
| 6 | Jauns brauciens; samaksa ar karti `4000 0025 0000 3155` (prasa apstiprinājumu — testa logā „Complete”) | „✓ Samaksāts ar karti” |
| 7 | Brauciens līdz galam (šoferis: atbraucu → iekāpis → galā). **Šoferis:** „Atmaksāt” | „↩ Atmaksāts”; iemesls `driver_refund` |
| 8 | Jauns samaksāts brauciens; Stripe panelī → maksājums → **Refund** daļai (piem. 2 € no 5 €) | Lietotnē „Atmaksāta daļa…”; pay-recent: paliek `paid` (daļēja atmaksa nav „refunded”); pay-check problēmas 0 |
| 9 | Jauns brauciens; karte `4000 0000 0000 9995` | Stripe lapā karte noraidīta; lietotnē nav samaksāts; datubāzē nav `paid` |
| 10 | Jauns brauciens; karte `4000 0000 0000 0259` (Stripe testa strīds) | Samaksāts; pēc brīža pay-check „strīdi” = 1, pay-recent webhook `charge.dispute.created → dispute_needs_response`; statuss paliek `paid` |
| 11 | Jauns brauciens; „Maksāt ar karti” divās cilnēs vienlaikus | Abās tā pati Stripe lapa (viena sesija; pay-recent `lapas` = 1 vai 2, samaksāts vienreiz) |
| 12 | `tools/pay-check.sql` | Visas „problēma:” rindas — 0; „gaida atmaksu” — 0 |

Rezultātu ieraksta tabulā zemāk (datums, kas izdevās, kas ne). Ja kāds solis neizdodas — Supabase → Edge Functions →
`stripe-webhook` / `ride-pay` → Logs un Stripe → Developers → Events (atbilde no webhook).

## Rezultāti

| Datums | Soļi | Rezultāts | Piezīmes |
|---|---|---|---|
| — | — | vēl nav veikts | |

## Pirms īstiem maksājumiem (`PAY_LIVE=yes`)

1. Visi 12 soļi izdevušies testa režīmā (tabula augstāk).
2. Jurista un grāmatveža apstiprinājums (README — „Īsti maksājumi”), laikapstākļu maksas plāns (README B04).
3. Stripe īstajā režīmā: platformas profils, Connect iestatījumi, **atsevišķs** īstā režīma webhook ar tiem pašiem notikumiem
   (tā `whsec_…` atšķiras no testa).
4. Supabase Secrets: `STRIPE_SECRET_KEY` = `sk_live_…`, īstā `STRIPE_WEBHOOK_SECRET`, `PAY_LIVE` = `yes` — to dara tikai īpašnieks.
5. Pirmais īstais maksājums — maza summa starp saviem kontiem, tad pilna atmaksa; `tools/pay-check.sql` — problēmas 0.
