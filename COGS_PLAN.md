# Plan: COGS via the gross margin method, with quarterly inventory counts

**Status:** **Phases 1–3 implemented** 2026-08-03 (all app code: `insights.js` pure functions + tests, new `InventoryOps.jsx` cards, Dashboard wiring; 73 tests, lint, build green). Phase 0 (data) still pending: the sealed cost ratio and markup clarification are obtainable now; a **reliable shelf count is ~a month out (≈ Sep 2026)**. Phase 0a (provisional backfill) can run as soon as ratios exist — enter them on the Monthly COGS card, then have the backfill CSV generated.
**Implementation deviations:** Book COGS lives on its own "Monthly COGS" card (beside the close checklist) which doubles as the ratio editor; the Phase 3 reserve uses trailing-3-complete-month average OpEx by category section rather than recurring-merchant estimates (check-paid inventory buys can masquerade as "recurring bills"); Phase 2's recalibration shows quarter-to-date booked-COGS % with a one-click "apply as blended %" (rest % stays manual in the editor).
**Scope:** `src/components/Dashboard.jsx`, `src/lib/insights.js`, `src/lib/settings.js` usage, one generated backfill CSV. New client workflow (weekly + monthly + quarterly). Includes the **Open to Buy** weekly purchase guardrail (Phase 3) — the client habitually overspends on inventory and is then short on cash for fixed expenses.
**Not in scope:** `Transactions.jsx` / `ImportModal.jsx` (concurrent refactor in flight), per-category COGS, lot/item tracking, Square item catalog. See "Deliberately deferred."

---

## 1. Context for a reviewer

The client buys inventory with cash/check against handwritten vendor receipts; there is no item-level tracking. As of 2026-08-03 the books treat inventory purchases as a balance-sheet asset (category **Inventory**, section Current Assets, ~$643k accumulated since Feb 2024) and no Cost of Goods Sold has ever been booked. The category **Product Costs** (section Cost of Goods Sold, zero transactions) is reserved for COGS. The dashboard currently shows amber "no COGS" flags on every profit figure; those flags are computed per month (`revenue > 0 && cogs === 0`) and clear automatically once COGS entries exist.

**The gross margin method:** each month, book `COGS = net revenue × COGS%`, relieving the Inventory asset by the same amount. Periodically do a physical shelf count *at cost* and push the difference between the book balance and the counted value into COGS (the "true-up"). The estimate keeps months comparable; the counts keep the estimate honest.

### Governing principle

> **Every adjustment is a zero-net pair of rows in `bank_transactions`, and the physical count is the source of truth.**

A COGS entry is two offsetting rows dated the last day of the month: one **negative** amount categorized `Product Costs` (hits the P&L as COGS), one **positive** amount categorized `Inventory` (relieves the asset). Net cash effect is zero, so account totals, runway math, and future bank-import dedup are untouched. All existing P&L computation (Dashboard `monthlyPL`, ReportsPL, insights) works unchanged because it only sums `amount` by `category` and `pl_section`.

Reserved markers so adjustments are identifiable forever:
- `account` = `"Adjustments"` (machine filter)
- descriptions `COGS ESTIMATE — <YYYY-MM>`, `INVENTORY RELIEF — <YYYY-MM>`, `COGS TRUE-UP — Q<n> <YYYY>` (human + idempotency check)

---

## 2. Decisions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Starting COGS % | **Provisional now, calibrated at the first count.** No good shelf estimate exists today; the first reliable count is ~a month out. So: start with a **provisional** rest % derived from the client's target markup (plus the real sealed ratio, Q3), then calibrate properly when the count lands — the count identity anchors to *any* date (`purchases through count day − shelf on count day = COGS through count day`), so nothing is lost by counting in September instead of August. The calibrated number bakes in shrinkage/markdowns the target never sees; the sealed anchor confines the provisional error to the non-sealed ~20–25% of revenue. Inputs: **(a)** sealed avg cost + typical price (now), **(b)** markup-or-margin clarification (now), **(c)** first shelf count at cost (~Sep 2026). |
| Q2 | Where adjustment entries live | **`bank_transactions` rows with `account='Adjustments'`** (vs. a new journal table). Reuses every existing P&L/report computation for free; months derive from `transaction_date` like everything else. Cost: `computeRecurring` must skip Adjustments rows (Phase 1d), and the upload-coverage grid grows an "Adjustments" column (acceptable — arguably informative). A journal table would touch every read path for no added correctness. |
| Q3 | Granularity | **Hybrid: sealed gets a real number, everything else gets the estimate.** The client tracks an **average cost for Sealed Products**, and sealed is **~75–80% of revenue** in every Square report that has a category breakdown — so anchoring sealed to its known cost leaves the estimate carrying only ~20–25% of revenue. `sealed COGS = sealed revenue × sealedCostRatio` (ratio = avg cost ÷ avg selling price; if Square can export *units sold*, `units × avg cost` is sharper still). The remainder (Singles + Supplies + Uncategorized) uses a calibrated `restPct`. **Fallback:** months with no Square category breakdown use a single `blendedPct`. Coverage today: breakdowns exist only from **2026-02** onward (earlier reports are all "Uncategorized"), and the **2026-03 report is missing** — so the backfill is mostly blended; the hybrid takes over going forward. Finer splits (singles vs. supplies) stay deferred (§6). |
| Q4 | Revenue base | **The app's own revenue** (categories `Square Deposits` + `Cash Deposits`). This is deposit-based — net of Square fees, including sales tax — not gross sales. That's fine: the % is calibrated against the *same* base it's applied to, so COGS dollars come out right by construction. Note for the accountant: the tax return may compute COGS differently (year-end count anchors both). |
| Q5 | True-up cadence & placement | **Quarterly** (Mar/Jun/Sep/Dec, the Dec count doubling as the year-end/tax count). One `COGS TRUE-UP` pair dated the quarter's final day. After each count, the app *suggests* a recalibrated % (implied % over the quarter); a human accepts or keeps the old one. |

---

## 3. Phased implementation

### Phase 0 — Update 2026-08-04: tax-return anchors + the 20% markup

The client's filed tax return(s) state year-end inventory (a guesstimate, not a count — but the best available anchor for history), and the client's standing markup is **20% on cost** ⇒ COGS ≈ **83.3% of selling price** (100/120; gross margin 16.7%).

Calibration design once the filed figures arrive:
- **2024 and 2025 anchor to the return.** `COGS_year = beginning inventory + purchases − ending inventory` per the filing; each year's effective ratio = `COGS_year ÷ revenue_year`; monthly entries distribute by revenue within the year. Book inventory then lands **exactly on the filed Dec-31 numbers** — the books agree with the returns, which the accountant will appreciate.
- **2026 runs at the 83.3% markup ratio** until the ≈Sep 2026 count trues it up; the Dec 31 2026 count aligns the next filing.
- The gap between each year's tax-implied ratio and 83.3% is reported, not hidden — it quantifies shrinkage/markdowns (or the guesstimate's error).
- With a uniform 20% markup, the sealed/rest hybrid collapses: all three ratios set to 83.3 until evidence says otherwise.

**Needed from the return(s)** (Schedule C Part III / Form 1125-A, Cost of Goods Sold): beginning inventory, purchases, ending inventory as filed — for tax years 2024 and 2025 if both exist. The filed *purchases* figure is also a valuable cross-check against the books ($136,775 in 2024, $295,116 in 2025).

*(The original count-anchored phasing below still applies to 2026; "provisional" ratios are now the markup-derived 83.3%.)*

### Phase 0 (original) — No code: provisional backfill now, calibrate at the first count

- **0a. Provisional backfill (can run immediately).** With the sealed cost ratio (real) and a provisional rest % (from the target markup), generate a CSV of entry pairs for every month with revenue (2024-02 → present): hybrid formula where a Square breakdown exists, `revenue(month) × blendedPct` otherwise; dated month-end, marked per §1 with descriptions reading `COGS ESTIMATE (PROVISIONAL) — <YYYY-MM>`. Import via the app's Import CSV (auto-detects; entries have no Ref Num, descriptions are unique per month, so dedup is safe). **Result:** the P&L becomes usable this month — margins roughly right (sealed anchored to its real cost; only the non-sealed ~20–25% rides on the markup guess), and the dashboard no-COGS flags clear. Skipping 0a and waiting for the count is also fine — the flags stay up and stay honest — but 0a is recommended.
- **0b. First count (~Sep 2026) → calibrate → regenerate.** Client counts the shelf **at cost** (what he paid, not sticker) on a one-page worksheet by Square category (Sealed / Singles / Supplies / Other; big-ticket graded cards listed individually). Calibration anchors to the count date: total COGS through that day = `purchases through that day − shelf on that day`; subtract the sealed-specific COGS for breakdown months, and the remainder over the corresponding revenue gives the calibrated `restPct`/`blendedPct`. Then **delete the provisional entries and regenerate the backfill** with the calibrated numbers — they're wholesale identifiable (`account='Adjustments'`), so this is a clean restatement, not a distorting catch-up entry in September. Sanity-check calibrated vs. target markup (e.g. 100% markup ⇒ 50% COGS; if calibrated says 68%, the 18-point gap is shrinkage/aging/markdowns — worth showing the client). From here the quarterly loop runs on schedule — the **Dec 31 count is next**, doubling as the year-end count.
- **0c. Plug the Square gaps.** Upload the missing **2026-03** Square report (and any pre-2025-06 reports the client still has emails for) — each recovered breakdown month upgrades from blended to hybrid.

**Acceptance (after 0b):** Inventory book balance within rounding of the counted value on the count date; ReportsPL shows a COGS section every month; no `PROVISIONAL` entries remain.

### Phase 1 — App: monthly close support

- **1a.** Setting `cogs_method` in `client_settings`: `{ sealedCostRatio, restPct, blendedPct, updatedAt, note }` (existing `getSetting`/`setSetting`).
- **1b.** **"Book COGS" action on the Dashboard** (on or beside the Monthly Close card): for the month being closed, uses the hybrid formula when that month's `square_reports` row has a category breakdown — `sealed revenue × sealedCostRatio + (other Square categories) × restPct` — else `revenue × blendedPct`; shows the math before booking, one click inserts the pair. Idempotent — disabled when a `COGS ESTIMATE — <YYYY-MM>` row already exists for that month. **Order dependency:** upload the Square report before booking COGS, or the month silently falls back to blended — the button should say which formula it's using.
- **1c.** `computeCloseChecklist` gains a fourth item: **"COGS booked"** (month has a Product Costs entry).
- **1d.** `computeRecurring` skips `account === 'Adjustments'` rows so monthly COGS entries can't appear in the Recurring Bills Radar (they'd otherwise qualify: monthly, negative, fairly consistent). Requires `account` in the dashboard's transaction select — verify, add if absent.
- **1e.** Adjacent one-line fix while in `insights.js`: `computeSalesTax` matches category `'Sales Taxes Paid'`, which doesn't exist in the live chart — should be `'Sales Taxes'`. (Pre-existing bug; the card currently shows $0 paid.)
- Unit tests for 1c/1d/1e in the existing vitest suites.

**Acceptance:** closing a month = import bank CSV → upload Square report → categorize → **Book COGS** → checklist fully green.

### Phase 1b — Sales tax liability *(implemented 2026-08-03, same session as the request)*

Collected sales tax is the state's money, not revenue. Mechanism, mirroring the COGS pattern:

- **Accounts added to the live chart (SQL):** `Sales Tax Collected` (Deductions to Income, sort 62) and `Sales Tax Payable` (Current Liabilities, sort 32).
- **Monthly accrual pair** per Square report with `tax_collected > 0`: `−tax → Sales Tax Collected` (reduces Net Revenue) + `+tax → Sales Tax Payable` (builds the liability), dated month-end, `account='Adjustments'`, descriptions `SALES TAX ACCRUAL/LIABILITY — <YYYY-MM>`. Booked from the **Month-End Entries** card (the former Monthly COGS card — one button books both pending pairs) and backfilled via SQL for all 13 report months.
- **Remittances reduce the liability:** bank payments to MA DOR dated **≥ 2025-07-01** were recategorized `Sales Taxes → Sales Tax Payable` (41 rows). The cutover is the first month whose remittance covers *accrued* collections (accruals start with the Jun 2025 report; June's collections were remitted in July) — no double-deduction anywhere. The 14 earlier payments stay in `Sales Taxes` (Deductions to Income) as the pre-accrual cash-basis treatment.
- **Liability balance** = sum of `Sales Tax Payable` rows; it ran **−$1,049 at migration** (advance payments ahead of accruals, plus the missing 2026-03 report understating accruals ~$1.9k — uploads/accrues later and the balance turns positive ≈ what's actually owed). The Sales Tax card shows this balance once accrual rows exist; `computeSalesTax` counts only real negative non-Adjustments rows as "paid"; Open to Buy reserves `max(0, liability)`.
- Close checklist gained **"Sales tax accrued"** (shown only for months whose report collected tax).

### Phase 2 — App: quarterly count + true-up

- **2a.** **Inventory card** on the dashboard: book balance (`−Σ` of Inventory-category amounts), last count date + value, next count due (quarter-end).
- **2b.** **True-up flow** on that card: enter the counted value → app shows `adjustment = book − counted` → confirm books a `COGS TRUE-UP — Q<n> <YYYY>` pair dated quarter-end (negative Product Costs if book > counted, i.e. shrinkage/underestimate; reversed if over-estimated). Count history appended to a `inventory_counts` setting: `[{ date, counted, bookBefore, adjustment }]` (promote to a table only if it ever outgrows settings).
- **2c.** **Recalibration suggestion** after each true-up: the sealed ratio is a known input (client updates it when wax costs move), so the true-up difference recalibrates **`restPct`/`blendedPct`** — implied quarterly % = `(non-sealed estimates + true-up) ÷ quarter non-sealed revenue`; show old vs. implied, one click to update. Never auto-applied.
- **2d.** Checklist shows a **"Quarterly count"** item in Mar/Jun/Sep/Dec closes (or when the last count is > 100 days old).

**Acceptance:** after a quarter-end close, Inventory book balance = counted value exactly, and the P&L absorbed the difference in that quarter.

### Phase 3 — App: "Open to Buy" weekly purchase guardrail

**The problem:** inventory buys are impulse-paced (a good collection walks in, the client writes a check) and have been consuming **~86% of revenue in 2026** ($212k of buys against $247k of deposits, Jan–Jun). When a big buy lands at the wrong moment there's no cash left for rent, payroll, or the sales-tax remittance. The guardrail answers one question before the checkbook opens: **"how much can we spend on inventory this week without endangering the fixed obligations?"**

**Formula (weekly open-to-buy):**

```
reserve        = next-30-day fixed obligations   (recurring bills + payroll avg + avg credit-card payment)
               + sales-tax set-aside owed         (already computed by computeSalesTax)
               + cash floor                       (client-chosen minimum, e.g. $5,000)
availableNow   = max(0, cash on hand − reserve)
availableUpper = availableNow + (trailing 4-week avg deposits × haircut, default 0.8)
```

Presented as a range: *spend now* vs. *spend as this week's deposits land*. Three states: **healthy** (green, `availableNow` ≥ a typical week's buys), **tight** (amber, positive but below typical), **hold** (red, `availableNow` = 0 → "cover expenses first").

- **3a.** Setting `purchase_budget` in `client_settings`: `{ cashFloor, reserveHorizonDays: 30, depositHaircut: 0.8 }`.
- **3b.** `computeOpenToBuy` in `insights.js` (pure, unit-tested): inputs = cash `{amount, asOf}`, `computeRecurring` output, payroll/CC-payment monthly averages from txns, `computeSalesTax` owed, settings → `{ reserve, breakdown, availableNow, availableUpper, state }`.
- **3c.** **Open to Buy card** on the dashboard (Path to Profitability row), reusing the *same* manual cash balance the Runway card already collects. Shows the range, the reserve breakdown (so the client learns *why*), and an amber staleness warning when the cash entry's `asOf` is > 7 days old — the number is only as good as Monday's balance entry.
- **Deliberately conservative v1:** the reserve holds a full 30-day obligation window even if some bills already cleared this month (the cash entry already reflects them, so this double-counts in the safe direction). Due-day inference from recurring history is a later refinement.
- **No dependency on Phases 0–2** — this can ship first if the cash-crunch problem is more urgent than margin truth.

**Acceptance:** Monday morning: client updates the cash balance, the card answers "what can I spend this week" with a defensible breakdown; a stale cash entry is visibly flagged.

---

## 4. The client's routine after this lands

**Weekly (~1 min, once Phase 3 lands):** Monday morning, enter the bank balance (the input already exists on the Runway card); read the Open to Buy range before writing any inventory checks that week.
**Monthly (~5 min added):** nothing new to collect — after the usual import + Square upload + categorize, click **Book COGS**. When the average sealed cost moves materially (wax price jumps), update `sealedCostRatio` in the same breath.
**Quarterly (~1–2 hrs):** count the shelf at cost on the worksheet, type one number into the Inventory card, accept/decline the suggested new %. December's count is the year-end count for the accountant.
**Every purchase (habit, feeds §6):** pencil category subtotals on the vendor receipt before filing it.

---

## 5. Risks and notes

- **The first count is the linchpin.** A sloppy count miscalibrates the % *and* misstates two years of backfilled margins. Counting at sticker instead of cost is the classic failure — the worksheet must say "what you PAID". Until it lands, provisional margins are directional, not settled.
- **Backfilled history is an estimate.** Every entry says `COGS ESTIMATE` in its description; month-to-month margin variation in history is by construction flat (`1 − pct`). Real variation appears only from Phase 2 onward.
- **Lumpy buys are fine.** Big collection purchases hit the balance sheet, not the P&L, so a $20k buy no longer craters a month — that's the point of the method.
- **Concurrent work:** `Transactions.jsx` / `ImportModal.jsx` are mid-refactor in another session. This plan deliberately touches only `Dashboard.jsx`, `insights.js`, and settings usage.
- **Dashboard no-COGS flags** (added 2026-08-03) need no changes — they key off per-month `cogs === 0` and clear as entries land.

## 6. Deliberately deferred

- Splitting the non-sealed remainder into per-category %s for Singles vs. Supplies (needs the receipt-subtotal habit from §4; sealed is already handled by Q3's hybrid).
- Unit-based sealed COGS (`units sold × avg cost`) if Square can export per-category unit counts — sharper than the revenue-ratio approach when discounting varies.
- `inventory_buys` / lot tracking integration ("relieve the lot as it sells"), specific-ID costing for big-ticket graded cards.
- Square item catalog with unit costs for sealed + supplies (register-level COGS).
- A real journal-entry table if adjustments ever outgrow the two-row-pair pattern.
- **Merchandise-level open-to-buy** once quarterly counts exist: with a trusted inventory balance and monthly COGS, the app can compute stock cover (weeks of inventory on the shelf at the current sales rate) and inventory turns — steering *what* to buy, not just how much cash is safe to spend. Due-day inference for the Phase 3 reserve belongs here too.
