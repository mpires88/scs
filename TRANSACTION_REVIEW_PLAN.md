# Plan: Fix the transaction review process

**Status:** Reviewed, amended, and **implemented** 2026-08-02 (all phases, using the recommended answers to Q1–Q4: warn, fill-gaps-only, vitest, `client_settings`). Commit `70b7be6` (which landed before the review) had already implemented Phase 0a's ordering fix (D2) and Phase 3b's import-button guard (D6), and added a partial D3 mitigation (`validAssignments`) that Phase 1 replaced. Line references below are against `70b7be6`. Automated verification passes (35 unit tests, lint, build); the manual checklist in §4 still needs a pass against real data.
**Scope:** `src/components/Transactions.jsx`, `src/components/ImportModal.jsx`, `src/components/CategoryInput.jsx`, `src/lib/merchantClustering.js`, `src/lib/csv.js`, `src/components/Shell.jsx`.
**Not in scope:** the P&L, dashboard, Square, or inventory-buys flows. See "Deliberately deferred" at the end.

---

## 1. Context for a reviewer

SCS Finance is a single-tenant bookkeeping app (Next.js 15 + Supabase). The transaction review screen is where a human assigns a chart-of-accounts category to every imported bank transaction. Everything downstream — the P&L, the dashboard — reads those categories. If a transaction silently stays uncategorized, it silently vanishes from the books.

**Current flow** (`Transactions.jsx`):

1. `load()` (`:57-94`) pulls all `bank_transactions` for the client in 1000-row `.range()` pages.
2. The `groups` memo (`:100-147`) buckets transactions by `normKey(description)`, then optionally fuzzy-clusters those buckets by Jaccard word overlap (`merchantClustering.js:51`).
3. Uncategorized groups get a suggested category mined from already-categorized rows (`suggestCat`).
4. The user accepts/rejects/types/bulk-applies. Edits land in a local `assignments` object keyed by group key. A `validAssignments` memo (`:155-161`) drops assignments whose group key no longer exists, so the pending count is honest — but the dropped work is still silently lost (D3).
5. `doSave()` (`:264-297`) resolves assignments to transaction IDs via `groups.find` and issues batched `UPDATE`s.

**The root cause of most defects:** all review state — `assignments`, `rejected`, `selected` — is keyed by **group key**, which is a *derived, unstable* identifier. A group key is `normKey(description)`; a *cluster* key is whichever member group happens to have the most transactions. Both change when the data changes or when the user toggles fuzzy mode. State keyed on them is silently orphaned or silently re-scoped.

### Governing principle for this plan

> **All review state anchors to transaction IDs. Group keys are for display only.**

Transaction IDs are stable database primary keys. Every fix in Phase 1 and Phase 4 is an application of this one rule. A reviewer should push back on any part of this plan that reintroduces group-key-anchored state.

---

## 2. Defects being fixed

Numbered for cross-reference. Severity is about impact on the correctness of the books, not code cleanliness.

| # | Defect | Location | Severity |
|---|---|---|---|
| D1 | A group with ≥1 categorized transaction is treated as fully categorized. Remaining transactions become invisible and uncounted. | `Transactions.jsx:165-173`, `:195`, `:207` | **Critical** |
| D2 | ~~Paginated load has no `ORDER BY`~~ **Fixed in `70b7be6`** (`Transactions.jsx:60-67`). Only the optional supporting index remains. | — | ~~Critical~~ Done |
| D3 | Toggling fuzzy mode silently drops or re-scopes pending assignments. (`validAssignments` makes the count honest but the work is still lost.) | `Transactions.jsx:155-161`, `:268-270` | High |
| D4 | Every keystroke in the category box commits an assignment; unvalidated free text reaches the DB. | `CategoryInput.jsx:30-34`, `Transactions.jsx:490` | High |
| D5 | Bulk Apply with an empty box mass-clears categories, no confirmation. | `Transactions.jsx:312-317` | High |
| D6 | ~~Import enabled during background paging~~ **Fixed in `70b7be6`** (`Transactions.jsx:356-361`). **Residual hole:** the paging loop silently `break`s on error (`:86`), so a failed page re-enables Import against a truncated list with no signal. See new Phase 0c. | `Transactions.jsx:86` | High (residual) |
| D7 | Fingerprint interpolates a raw float. The real duplicate path is float arithmetic in split debit/credit mode (`credit − debit` → `13.809999…` vs. the DB's rounded `13.81`), not Postgres serialization — numerics arrive through `JSON.parse` identical on both sides. | `csv.js:58-61`, `ImportModal.jsx:110` | Medium |
| D8 | Suggestion source is first-wins. With D2 fixed it is now deterministic but "oldest transaction wins" — a single old miscategorization is still a merchant's permanent suggestion. | `Transactions.jsx:106-112`, `ImportModal.jsx:138-146` | Medium |
| D9 | No unsaved-changes guard; `next/link` nav discards pending work silently. | `Transactions.jsx`, `Shell.jsx:160-184` | Medium |
| D10 | "Remove from group" and dismissed suggestions do not survive a reload. | `Transactions.jsx:25-26` | Medium |
| D11 | Counters are group-based but read as transaction-based. | `Transactions.jsx:207-209`, `:342-346` | Low |
| D12 | Selection persists across search/filter changes. (Fuzzy toggle and separate/rejoin already clear it: `:398`, `:183-184`.) | `Transactions.jsx:188` | Low |
| D13 | Full regroup + recluster fires on every background page (O(n²) clustering × ~20). | `Transactions.jsx:88` | Low |

---

## 3. Phased implementation

Phases are ordered by dependency, then by value-per-risk. **Phase 1 must land before Phase 5** — see the note there.

---

### Phase 0 — Trivial correctness + safety net

**0a. Add a total ordering to the paginated query** *(fixes D2)* — **already done in `70b7be6`** (`Transactions.jsx:60-67`). Remaining piece only:

Supporting index (optional, add to `supabase/migration.sql`):

```sql
create index if not exists bank_transactions_client_date_id_idx
  on public.bank_transactions (client_id, transaction_date, id);
```

*Non-blocking note for the reviewer:* `.range()` is OFFSET pagination, which is O(n²) across the full scan. Keyset pagination (`.gt('id', lastId)`) would be strictly better. At this app's scale (low tens of thousands of rows) OFFSET is fine and I am not proposing we change it. Flagging so it isn't mistaken for an oversight.

**0b. Test harness for pure logic** *(decision point — see §5, Q3)*

There is currently **no test infrastructure**: no test script in `package.json`, no test files. Phases 1 and 3 change the semantics of deduplication and category suggestion — exactly the kind of change that needs pinning down.

Proposed: add `vitest` as a devDependency and cover the pure functions only:

- `csv.js` — `parseDate` (all 6 formats, rejection of Feb 31), `fingerprint` (before and after the D7 fix — the key case is the `credit − debit` float artifact, e.g. `27.31 − 13.5` fingerprinting equal to `13.81`), `parseCSVText` (quoted fields, embedded commas, CRLF). The metadata-preamble strip and summary-row filter currently live inside `ImportModal.handleFile`; extract them into a pure `parseBankCSV(text)` in `csv.js` so they are testable too.
- `merchantClustering.js` — `normKey`, `wordSim`, `suggestCat` threshold behavior, `clusterGroups` union-find correctness.
- The new `groupStatus` / `dominantCat` / `buildDescCatMap` helpers from Phases 1 and 3.

No component or DOM tests. Pure functions only — fast, no jsdom, no CI changes needed.

**0c. Surface background-paging errors** *(closes D6's residual hole)*

The paging loop (`Transactions.jsx:84-91`) silently `break`s when a page fails, leaving a truncated list that looks complete — and, because `loadingMore` goes false, re-enables Import against it. A page error must set `loadError` (rendering the error screen) instead of silently truncating. `loadingMore` is now the safety gate for D6, so a truncated list must never pass as loaded.

---

### Phase 1 — Re-anchor review state to transaction IDs

This is the core of the plan. D1 and D3 are two symptoms of one defect and are fixed by the same change.

**1a. Change the shape of `assignments`**

```js
// before: { [groupKey]: category }
// after:  { [txnId]: category }   // category '' means "clear this transaction"
const [assignments, setAssignments] = useState({})
```

Derive a single accessor used everywhere:

```js
const catOf = useCallback(
  t => (t.id in assignments ? assignments[t.id] : (t.category || '')),
  [assignments]
)
```

Setting a category on a group writes it for every transaction in that group:

```js
const assignGroup = (g, cat) =>
  setAssignments(p => {
    const next = { ...p }
    g.txns.forEach(t => { next[t.id] = cat })
    return next
  })
```

Consequences, all of which are the point:

- Toggling fuzzy mode no longer touches assignments — they are anchored to rows, not to derived keys. **D3 is fixed structurally**, not patched.
- `doSave` no longer needs `groups.find(...)` (`:269`) and can no longer silently drop an assignment via the `if (g)` with no `else`.
- The `validAssignments` memo (`:155-161`) — the partial mitigation from `70b7be6` — becomes dead code and **must be deleted**.
- Separating a transaction preserves its pending category.
- Replacing the `txns` array mid-edit (Phase 5) no longer clobbers in-progress work.

**1a′. Re-key `rejected` to transaction IDs** *(moved here from Phase 4 — review finding)*

1d's redefined `hasSugg` calls `rejected.has(t.id)`, but `rejected` is an object keyed by group key (`:25`, `:180`) until re-keyed. As originally sequenced (re-key in Phase 4a), Phase 1 would not work. The in-memory re-key to `Set<txnId>` — populated with the group's uncategorized transaction IDs at dismissal time — lands **here**; Phase 4a keeps only the persistence.

**1b. `doSave` simplification**

```js
const doSave = async () => {
  const byCat = {}
  for (const [id, cat] of Object.entries(assignments)) {
    const saved = txnById.get(id)?.category || ''
    if (cat === saved) continue                 // no-op, skip the write
    const k = cat || '__null__'
    ;(byCat[k] ??= []).push(id)
  }
  // ...existing 500-row batched UPDATE loop, unchanged...
}
```

Note the added no-op skip: today, re-typing the value a transaction already has still issues a write. Filtering these out makes `pendingCount` honest and reduces write volume.

**1c. Four-valued group status** *(fixes D1)*

New pure helper, colocated with the other categorization logic (see 3d):

```js
export function groupStatus(txns, catOf) {
  const cats = txns.map(catOf)
  const uncategorized = cats.filter(c => !c).length
  const distinct = new Set(cats.filter(Boolean))
  if (uncategorized === cats.length) return { kind: 'none',     uncategorized, distinct }
  if (distinct.size > 1)             return { kind: 'mixed',    uncategorized, distinct }
  if (uncategorized > 0)             return { kind: 'partial',  uncategorized, distinct }
  return                                    { kind: 'complete', uncategorized, distinct }
}
```

`mixed` takes precedence over `partial` because conflicting categories are the more urgent signal. A group can be both; the badge should report both facts (see 1e).

**1d. Filter and counter semantics** *(fixes D1, D11)*

| Tab | Current predicate | New predicate |
|---|---|---|
| Uncategorized | `!dominantCat(g.txns)` | `status.uncategorized > 0` |
| Categorized | `dominantCat(g.txns)` | `status.uncategorized === 0` |
| Suggestions | `hasSugg(g)` | `hasSugg(g)` (redefined below) |
| **Mixed** *(new)* | — | `status.kind === 'mixed'` |

`hasSugg` currently requires `!dominantCat(g.txns)` (`:157`), which is why a partially-categorized group never gets a suggestion. Redefine:

```js
const hasSugg = g => !!g.suggestedCat
  && groupStatus(g.txns, catOf).uncategorized > 0
  && g.txns.some(t => !catOf(t) && !rejected.has(t.id))
```

Counters (`:192-194`, header `:327-330`) switch from groups to transactions:

```js
const uncatTxnCount = txns.filter(t => !catOf(t)).length
const pendingTxnCount = /* count of assignments that differ from saved */
```

Header reads: `N merchant groups · M transactions · K transactions uncategorized`.

> **⚠ Expected outcome, not a regression.** After this change the Uncategorized tab will very likely show *more* groups than before, and the uncategorized counter will jump. That is the defect surfacing, not a new bug. Anyone reviewing the result should expect it. It would be worth running a `select count(*) from bank_transactions where client_id = ... and (category is null or category = '')` before and after to confirm the new number matches reality.

**1e. UI affordances for partial and mixed groups**

The category cell currently shows `dominantCat` with no indication that the group is heterogeneous. Add a badge next to the description:

- `partial` → `12 of 50 uncategorized` (amber)
- `mixed` → `2 categories` (amber), tooltip listing them with counts
- `complete` → no badge

The expanded transaction list (`:496-543`) must gain a **Category** column showing each row's effective category, so a user who sees "mixed" can immediately see which rows differ. This is what converts D1's *silent* recategorization into an *informed* one.

**1f. Overwrite policy** *(decision point — see §5, Q2)*

Proposed asymmetry:

- **Explicit user edit** (typing/selecting a category on a group row, or Bulk Apply) → overwrites **all** transactions in the group. Bookkeepers legitimately want to fix an entire merchant at once, and 1e now makes the blast radius visible before they commit.
- **Accepting a suggestion** (`✓` button, or "Accept all") → fills **only uncategorized** transactions, never overwrites an existing category.

Rationale: an automated bulk action should not be able to overwrite work a human already did. An explicit, visible, single-group edit can. `acceptAll` (`:284-288`) becomes materially safer under this rule.

---

### Phase 2 — Input safety

**2a. `CategoryInput` commits on selection or blur, not per keystroke** *(fixes D4)*

`CategoryInput.jsx:30-34` currently calls `onChange` on every character. Change to:

- Keep `query` purely local while typing.
- Call `onChange` on: dropdown item `mousedown`, and `Enter` (selects the first match, as today; with **no** match, `Enter` commits the trimmed free text — that is the deliberate new-category path, covered by 2b's warning).
- On `blur`: if the trimmed text case-insensitively equals a known category, commit the canonical name; otherwise **revert** to `value`. *(Amended from the original "commit on blur if changed" — that would have re-introduced D4; the manual checklist ("type `xyz`, click elsewhere → no pending change") was always the intended spec.)*
- `Escape` reverts `query` to `value` and closes without committing.
- Preserve the existing render-time controlled-value sync at `:16-19`.

This kills the "type three letters, click away, save a garbage category" path while still letting completed typing of a real category stick without an explicit click.

*Optional, low priority:* arrow-key navigation in the dropdown. Currently there is none — `Enter` blindly takes the first match. Not required for correctness; call it out and leave it.

**2b. Unknown-category warning** *(decision point — see §5, Q1)*

Free text is still permitted (the chart of accounts is user-managed via `ChartOfAccounts.jsx`, so free text is a plausible intentional workflow). Instead of blocking it:

- Category inputs whose value is not in `allCats` render with an amber border.
- Before `doSave` runs, if any pending assignment names a category not in the chart of accounts, show a confirm: *"3 groups use categories not in your chart of accounts: 'Suplies', … Save anyway?"*

This catches typos without removing the ability to introduce a new account name mid-review.

**2c. Bulk Apply guard** *(fixes D5)*

- Disable the Apply button when `bulkCat.trim() === ''`.
- Apply the **trimmed** value — `applyBulk` currently commits `bulkCat` raw, so `"Food "` would silently create a category distinct from `"Food"`.
- Add a separate `Clear categories` button to the bulk bar that confirms with a **transaction** count: *"Clear the category on 214 transactions across 12 groups?"*

The capability is preserved; the accidental path is removed.

**2d. Clear selection on filter change** *(fixes D12)*

Extend the existing effect at `:173`:

```js
useEffect(() => { setPage(0); setSelected(new Set()) }, [search, filter, fuzzy])
```

Selection deliberately still persists across *pages* — that is a real feature. Note the fuzzy toggle and separate/rejoin already clear selection inline (`:398`, `:183-184`); the effect above closes the remaining gap (search/filter) and makes the fuzzy clear redundant but harmless.

---

### Phase 3 — Import integrity

**3a. Normalize the fingerprint** *(fixes D7)*

`csv.js:58-61`:

```js
export function fingerprint(row) {
  if (row.reference_id) return `ref:${String(row.reference_id).trim()}`
  const amt = Number(row.amount)
  const amtKey = Number.isFinite(amt) ? (amt === 0 ? 0 : amt).toFixed(2) : 'NaN'
  const desc = (row.description || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return `${row.transaction_date}|${amtKey}|${desc}`
}
```

Two changes: `toFixed(2)` on both sides of the comparison, and whitespace collapsing in the description (banks pad descriptions inconsistently between exports of the same transaction).

*Mechanism, corrected by review:* the duplicate path is **not** Postgres serializing `12.10` — supabase-js receives numerics through `JSON.parse`, so both sides hold the identical JS number. The real path is float arithmetic in split debit/credit mode: `amount = credit − debit` (`ImportModal.jsx:110`) yields values like `13.809999999999998`; the DB rounds to scale on insert and returns `13.81`; the fingerprints diverge and the duplicate imports. `toFixed(2)` fixes exactly this. The `(amt === 0 ? 0 : amt)` guard handles the `debitsPositive` flip of a zero amount: `(-0).toFixed(2)` is `"-0.00"`, which would never match the DB's `"0.00"`.

*Migration risk: none.* Fingerprints are computed fresh on every import and never stored, so there is no persisted data to migrate.

*Behavioral note:* whitespace collapsing makes dedup strictly **more** aggressive. If the reviewer thinks that could suppress a legitimate distinct transaction, it can be dropped independently of the `toFixed` fix — the two are separable and `toFixed` is the one that matters.

*Follow-up worth mentioning to the user:* if duplicates were already imported because of this bug, fixing the fingerprint does not remove them. A one-time duplicate audit query would be a separate small task.

**3b. Block import against an incomplete list** *(fixes D6)* — **already done in `70b7be6`** (`Transactions.jsx:356-361`, tooltip included). The residual hole — the paging loop silently truncating on error and un-gating the button — is Phase 0c.

*Alternative considered and deferred:* have `ImportModal` fetch its own fingerprint set directly from the DB (a narrow `select id, transaction_date, amount, description, reference_id`), removing the dependency on parent state entirely. More robust, but duplicates the paging logic and is more work. The button-disable is sufficient given Phase 5 shortens the loading window. Recommend revisiting only if the transaction count grows substantially.

**3c. Deterministic, dominant-based suggestion source** *(fixes D8)*

Both `Transactions.jsx:102-108` and `ImportModal.jsx:143` build `descCatMap` with `if (k && !descCatMap[k])` — first-wins. Combined with D2's unordered fetch, which category wins was nondeterministic, and a single historical miscategorization could become a merchant's permanent suggestion.

Replace with a tally that picks the most common category per normalized key, with a **deterministic tie-break** (count descending, then category name) — otherwise ties re-introduce D8's instability via object iteration order. This also makes the suggestion source agree with `dominantCat`, which is what the UI already displays; give `dominantCat` the same tie-break.

**3d. Extract the duplicated helper**

`dominantCat` is copy-pasted identically in `Transactions.jsx:9-13` and `ImportModal.jsx:11-15`. Move it, plus the new `groupStatus` and `buildDescCatMap`, into a shared module — `src/lib/categorize.js` — and import from both. Pure functions, directly unit-testable under Phase 0b.

---

### Phase 4 — Durability of review state

**4a. Persist `separated` and `rejected`** *(fixes D10)* *(decision point — see §5, Q4)*

Both are in-memory only today (`:25-26`). Consequences: "Remove from group" is a single-session operation whose effect becomes invisible after reload (and, pre-Phase-1, was actively hidden by D1), and dismissed suggestions reappear every session.

The re-key of `rejected` to `Set<txnId>` happens in **Phase 1a′** (it is a Phase 1 dependency — see the review note there); this phase only persists it. `separated` is already `Set<txnId>` and needs no change.

*Semantics note:* per-transaction dismissal means newly imported transactions for the same merchant will resurface the suggestion (their IDs are not in `rejected`). That is the intended behavior — a dismissal covers the rows it was made against, not the merchant forever — but it is a change from what group-key dismissal would have done.

Proposed storage: the existing `client_settings` k/v table (`migration.sql:14-20`) via the existing `getSetting`/`setSetting` helpers in `src/lib/settings.js` — **no schema change required**.

```
client_id = <CLIENT_ID>
key       = 'txn_review_state'
value     = { "separated": ["<uuid>", ...], "rejected": ["<uuid>", ...] }
```

Load alongside the first page in `load()`; write debounced on change. Prune IDs not present in `txns` so deleted transactions don't accumulate forever — but **only after the full load completes**: pruning against the first 1000-row page (or Phase 5's still-accumulating array) would wrongly discard valid IDs.

*Known limitation:* a single JSONB blob means concurrent editors clobber each other. This is a declared single-user app (see `migration.sql:43-50`), so this is acceptable — but the reviewer should confirm that assumption still holds before this ships.

**4b. Unsaved-changes guard** *(fixes D9)*

Two parts, very different in cost:

- **`beforeunload` listener** while `pendingTxnCount > 0`. Covers tab close and refresh. ~5 lines, entirely inside `Transactions.jsx`.
- **In-app navigation.** `next/link` does not fire `beforeunload`, so clicking "Dashboard" mid-review still discards silently. Requires a small `UnsavedChangesContext` provided in `Shell.jsx`, set by `Transactions`, and checked in `NavItem`'s `onClick` (`Shell.jsx:161-182`).

Recommend shipping `beforeunload` first — it is most of the value for a fraction of the effort and touches one file. The context work is worth doing but is the only part of this plan that modifies `Shell.jsx`, and should be a separate commit so it can be reverted independently.

---

### Phase 5 — Load performance

**5a. Single state commit after background paging** *(fixes D13)*

`Transactions.jsx:84` calls `setTxns(all)` inside the paging loop. Each call re-runs the `groups` memo, and `clusterGroups` is O(n²) within lead-word buckets (`merchantClustering.js:72-77`). At 20k transactions that is ~20 full reclusters during load.

Change: keep the immediate first-page render (that UX property is good — the screen is usable in ~1s), then accumulate into a local array and `setTxns` **once** when paging completes. One recluster instead of N.

> **Dependency: this must land after Phase 1a.** Today, replacing the `txns` array mid-edit orphans any group-key-anchored assignment the user made against the first page. Once assignments are keyed by transaction ID, they survive the array swap cleanly. Doing Phase 5 first would introduce a new data-loss window.

*Caveat (review finding):* ID-keyed assignments survive the final `setTxns`, but a **save completed during** the loading window would not — `doSave` patches `txns` and clears the assignments, and the final commit would revert those rows to their pre-save fetched values (UI-only staleness; the DB is correct). The final commit therefore **merges by ID**, preferring the in-memory row's `category` where it differs from the fetched copy.

---

## 4. Verification

**Automated** (Phase 0b, if adopted): unit tests for `parseDate`, `fingerprint` (explicitly including the `12.10`/`12.1` case), `parseCSVText`, `normKey`, `wordSim`, `clusterGroups`, `dominantCat`, `groupStatus`.

**Manual checklist** — each item maps to a defect:

- [ ] **D1** — Take a group of ~20 transactions, categorize exactly one, reload. The group must appear under Uncategorized with a `19 of 20 uncategorized` badge and be included in the header count.
- [ ] **D1** — Give two transactions in one group different categories. Group shows `2 categories`; expanding shows both.
- [ ] **D2** — With >1000 transactions loaded, confirm `txns.length` equals `select count(*)` and that no `id` appears twice.
- [ ] **D3** — Assign categories to 3 groups in fuzzy mode, toggle fuzzy off, toggle back on. All 3 assignments still pending, unchanged in scope; `Save (N)` shows a stable N.
- [ ] **D4** — Click a category box, type `xyz`, click elsewhere without selecting. No pending change is created.
- [ ] **D4/2b** — Type a genuinely new category name and select it. Amber border appears; save prompts once, then succeeds.
- [ ] **D5** — Select groups, leave the bulk box empty. Apply is disabled. `Clear categories` confirms with a transaction count.
- [ ] **D6** — With >1000 transactions, click Import immediately on page load. Button is disabled until loading completes.
- [ ] **D7** — Import a CSV containing a row already in the DB whose amount is a two-decimal value ending in zero (e.g. `12.10`). It is reported as a duplicate, not inserted.
- [ ] **D8** — Reload twice; the suggested category for a given merchant is identical both times.
- [ ] **D9** — With pending changes, click a sidebar link and close the tab. Both prompt.
- [ ] **D10** — Separate a transaction, save, reload. It remains separated. Dismiss a suggestion, reload. It stays dismissed.
- [ ] **1f** — On a group with 5 categorized / 5 uncategorized transactions, "Accept all" fills only the 5 uncategorized. Typing a category directly on the group row changes all 10.
- [ ] **Regression** — Import a fresh CSV end-to-end; imported counts match the result screen; P&L totals move by the expected amount.

**Suggested pre-flight:** snapshot `select category, count(*) from bank_transactions group by category` before and after Phase 1 lands. The only expected delta is from edits made deliberately during testing.

---

## 5. Decision points for the user

These change the shape of the work and should be settled before Phase 1 starts. Recommendations given, but they are workflow preferences, not technical calls.

**Q1 — Free-text categories: warn or block?**
Recommend **warn** (§2b). Blocking is safer against typos but forces a detour to the Chart of Accounts page mid-review, which may not match how the books actually get done.

**Q2 — Should accepting a suggestion overwrite an existing category?**
Recommend **no** — fill gaps only, while explicit edits overwrite (§1f). The asymmetry is the whole safety property; if the user disagrees, 1e's visibility work becomes more load-bearing.

**Q3 — Add `vitest`?**
Recommend **yes**. Adds one devDependency and covers pure functions only. This plan changes dedup and suggestion semantics with zero current safety net. If declined, Phases 1 and 3 rest entirely on the manual checklist.

**Q4 — Persist review state to `client_settings`, or `localStorage`?**
Recommend **`client_settings`** — the table already exists, no schema change, and state follows the user across devices. `localStorage` needs no backend write but drifts from DB state and is per-browser.

---

## 6. Deliberately deferred

Considered and excluded, so the reviewer knows these were not overlooked:

- **Audit trail** (who categorized what, when; undo for bulk apply). Genuinely valuable for books an accountant may review, but it needs a schema change and a UI surface. Separate piece of work.
- **RLS tightening.** `migration.sql:59-60` grants every authenticated user full access to all rows, with `client_id` enforced only client-side. The migration documents this as an intentional single-owner model contingent on public signups being disabled. Correct as declared; revisit when a second user is added.
- **Keyset pagination** (§0a note). OFFSET is adequate at this scale.
- **Self-fetching import dedup** (§3b alternative). More robust, more code; the button-disable covers the actual failure.
- **Arrow-key dropdown navigation** (§2a note). UX polish, not correctness.
- **Server-side grouping/clustering.** The entire transaction set is loaded and clustered in the browser. This is fine at current scale and Phase 5 removes the acute cost. If the dataset grows past ~50k rows, revisit.

---

## 7. Summary

| Phase | Fixes | Files touched | Risk |
|---|---|---|---|
| 0 | D2 index (D2 itself done), D6 residual (0c), test harness | `Transactions.jsx`, `migration.sql`, `package.json`, `csv.js` | Very low |
| 1 | D1, D3, D11 (+ `rejected` re-key, `validAssignments` removal) | `Transactions.jsx`, new `lib/categorize.js` | **High — core change** |
| 2 | D4, D5, D12 | `CategoryInput.jsx`, `Transactions.jsx` | Medium |
| 3 | D7, D8 (D6 done) | `csv.js`, `ImportModal.jsx`, `lib/categorize.js` | Medium |
| 4 | D9, D10 | `Transactions.jsx`, `Shell.jsx` | Medium |
| 5 | D13 | `Transactions.jsx` | Low (after Phase 1) |

D2 already shipped in `70b7be6`; Phase 1 addresses the one remaining Critical defect (D1). If only one phase ships, it should be Phase 1.
