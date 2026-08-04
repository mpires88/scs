# Plan: Bank and credit-card accounts as first-class balance-sheet accounts

**Status:** **Phases A + B implemented** 2026-08-03 (registry seeded with both accounts and all three feed labels; builder + tests + admin panel live; 117 tests, lint, routes green). Phases C (reconciliation anchors) and D (cash truth for the guardrails) remain. Card opening balance still 0 — needs the Aug 2025 statement's starting balance from the client.
**Scope:** `src/lib/balanceSheet.js`, `src/components/ReportsBS.jsx`, a small admin UI (Chart of Accounts page), `client_settings`, Runway/Open-to-Buy cash sourcing in `Dashboard.jsx`/`insights.js`.
**Not in scope:** importing the missing Capital One statements (but see the PDF-statement importer note in §6), Square in-transit balances.

---

## 1. Context for a reviewer

Physical accounts (the Freedom checking account, the Capital One card) exist in the app only as **free-text strings** in `bank_transactions.account`, stamped by whatever the import file said. The balance sheet (added 2026-08-03) derives a cash line per string (`Cash — <account>`, Σ of its rows) and flips negative-balance accounts to a liability line (`Owed on <account>`). It balances by construction, but the account modeling has four defects, all visible in live data:

| # | Defect | Evidence (live, 2026-08-03) |
|---|---|---|
| D1 | **Feed-label drift splits one account into many.** Every new spelling becomes a new "account" line. | The July 2026 upload labeled the card `Capital One ...3877` (4 rows); the historical import used `Capital One Credit Card` (39 rows). Two lines, one card. |
| D2 | **The card is represented twice and anchored to nothing.** A derived `Owed on …` line (card-feed rows) *plus* the standalone `Credit Card Payment` category line (Current Liabilities) split one liability across two half-truths. Card-feed coverage stopped Nov 2025 while checking-side payments continue, so the merged ledger position reads **overpaid ~$4,155** — really the un-imported Dec 2025+ charges and an unknown pre-Aug-2025 opening balance. | card rows −2,895.41 net · checking-side payments −10,550 · category line and derived line partially overlap Sep–Nov 2025 |
| D3 | **Two sources of truth for cash.** The sheet derives checking cash from the ledger; Runway and Open to Buy use the manually-entered `cash_balance` setting. They never see each other. | |
| D4 | **No opening balances.** Fine for checking (the ledger starts at the account's birth, Feb 2024); wrong for the card, which entered the books mid-life (Aug 2025). | |

### Governing principle

> **Physical accounts live in a registry that maps every feed label to exactly one balance-sheet line. Balances stay ledger-derived — opening balances and statement reconciliations are builder inputs, never fake transactions.**

The sheet's balances-by-construction identity is preserved throughout: every change below is a *regrouping* of lines the identity already contains, plus explicit opening/equity offsets.

---

## 2. Decisions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Where does the registry live? | `client_settings` key **`ledger_accounts`** (JSON array) — single-tenant, a handful of accounts; promote to a table only if it outgrows settings. Shape: `{ key, label, type: 'bank'\|'card', section, matches: [feedLabels…], boundCategories: [categoryNames…], opening: { date, balance } \| null, reconciliations: [{ date, balance }…] }`. |
| Q2 | Are these chart-of-accounts categories? | **No.** Accounts ≠ categories: nobody should ever *categorize* a transaction "to the checking account", and the categorizer's dropdowns must not grow account entries. The registry is a parallel structure surfaced on the balance sheet, administered from a new "Bank & Card Accounts" panel on the Chart of Accounts page. |
| Q3 | How is one card line computed? | **Uniform two-sided bucketing** (as implemented — this row's original draft formula had a sign error): every row contributes once on the *account side* and once on the *category side*, exactly the two decompositions the sheet's identity already rests on. A registry entry collects both sides into one bucket — account side: bank rows `+amt`, card rows `−amt` (charges build debt); category side: bound-category rows `+amt` (a payment from checking, amount −400, lowers owed by 400). A transfer visible on **both** feeds self-cancels inside the card bucket: the card-feed echo contributes `−(+400)` on the account side and `+400` on the category side — net zero. Numerically the line equals the sum of the two lines the sheet showed before (pure regrouping), so the balance identity is untouched. The standalone `Credit Card Payment` line disappears from the sheet; the category remains the transfer marker on transactions. |
| Q4 | How do balances get anchored to reality? | **Manual statement anchors:** per account, `{ date, balance }` entries (typically month-end, from the bank/card statement). The sheet shows a per-account status chip — *reconciled ✓* when computed ≈ statement (within $1), amber *off by $Δ* otherwise. The card's Δ will read ≈ its un-imported charges: the honest number that motivates importing the missing statements rather than hiding the gap. |
| Q5 | Which cash number do Runway / Open to Buy use? | Both: the **derived checking balance** (as of the last imported row) becomes the baseline shown on the cards, and the Monday **manual entry stays as the freshness layer** (the feed is monthly; the guardrail is weekly). When the manual entry and the derived balance diverge beyond a threshold at the same date-ish, flag it — that's either un-imported activity or a typo. Replacing the manual entry entirely was rejected: a monthly feed can't power a weekly guardrail. |

---

## 3. Phased implementation

### Phase A — Registry, mapping, and balance-sheet integration

- Seed `ledger_accounts` with the two known accounts: *Freedom Checking* (`bank`, Current Assets, matches `FREEDOM CHECKING FOR BUSINESS`) and *Capital One Card* (`card`, Current Liabilities, matches both `Capital One Credit Card` and `Capital One ...3877`).
- `buildBalanceSheet` consumes the registry: registry accounts render with their labels and sections; **unmapped** feed labels still render derived as today, plus an amber "unmapped account — add it to the registry" nudge (new labels keep appearing as banks change export formats; they must degrade loudly, not silently).
- Admin UI on the Chart of Accounts page: list registry accounts, edit label/matches/opening, map an unmapped feed label in one click.

**Acceptance:** the card is ONE line regardless of feed label; cash line reads "Cash — Freedom Checking"; an artificial unknown label shows the nudge.

### Phase B — Card fold + opening balances

- Bind `Credit Card Payment` to the card account (Q3 formula); remove the standalone category line from the sheet.
- Opening balances: when `opening.balance ≠ 0`, the account line starts there and an **Opening Balance Equity** derived line (Equity section) carries the offset — identity preserved explicitly, and tested.
- The card's opening is unknown → leave 0 until the client digs up the Aug 2025 statement's starting balance; the reconciliation chip (Phase C) carries the discrepancy meanwhile.

**Acceptance:** single card line; sheet balances to the penny with and without openings (unit-tested identity).

### Phase C — Statement reconciliation

- Per-account anchors `{ date, balance }` entered from the admin UI or the balance sheet itself; status chips per Q4.
- Monthly close checklist gains **"Accounts reconciled"** (all registry accounts have an anchor within the close month and Δ < $1 — or the item shows the offending account and Δ).
- Copy explains the card's expected drift until its statements are imported.

**Acceptance:** entering the real checking statement balance for the close month turns the chip green (the checking ledger should already match); the card chip shows an honest Δ.

### Phase D — One cash truth for the guardrails

- Runway and Open to Buy read the derived checking balance as baseline; the manual Monday entry remains and is compared against it (Q5). Divergence flag replaces today's silent coexistence.

**Acceptance:** with a fresh import and no manual entry, the guardrail still works from derived cash; with both present and disagreeing, the flag shows.

---

## 4. What this fixes on the statement, concretely

Before → after (Current Liabilities): `Owed on Capital One Credit Card` + `Owed on Capital One ...3877`(or a stray cash line) + `Credit Card Payment (negative)` → **`Credit Card — Capital One`**, one line, with a chip: *off by $Δ — card statements Dec 2025+ not imported*. Current Assets: `Cash — FREEDOM CHECKING FOR BUSINESS` → **`Cash — Freedom Checking`** with *reconciled ✓* once anchored.

## 5. Risks and notes

- **Identity is the invariant.** Every phase lands with the assets = liabilities + equity test extended (registry grouping, both-feed transfers, openings, unmapped labels).
- **Bound-category edge:** a payment visible ONLY on the card feed (no checking-side row) self-cancels and therefore has **no effect** on the owed balance — the model takes a transfer's effect from the paying account's side. In practice every payment comes from the mapped checking account, so this never bites; if it ever did, the reconciliation chip (Phase C) would surface the drift. A payment made from an unmapped account is covered by the unmapped-label nudge. |
- **Don't let registry labels collide with category names** — validation in the admin UI.

## 6. Deferred / synergies

- **Capital One statement import** closes the card's reconciliation Δ properly — the PDF-statement importer currently in development (`src/lib/pdfStatement.js`) looks like it will be exactly this feed; when it lands, the card's charges resume and the chip converges on its own.
- Assisted catch-up entry ("book the Δ as …") for gaps the client chooses not to backfill.
- Square in-transit clearing account (deposits en route from Square at month end) as a Current Asset.
