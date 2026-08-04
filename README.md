# SCS Finance

Bookkeeping and profitability dashboard for **Sports Card Station** (Norfolk, MA).
Next.js (App Router) + React 19 + Supabase.

Routes: `/` (Dashboard) · `/transactions` · `/close` · `/pl` · `/balance` · `/year-end` ·
`/buys` · `/accounts` · `/square` · `/settings` · `/help`

## What it does

| Page | Purpose |
|---|---|
| **Dashboard** | KPIs, breakeven sales target, cash runway, sales-tax set-aside, monthly close checklist, recurring-bills radar, margin by product line, revenue/P&L charts |
| **Transactions** | Import bank CSVs, fuzzy merchant grouping, category suggestions, bulk categorization |
| **Month-End Close** | The whole monthly routine for one month: live step statuses, book the COGS estimate and sales-tax accrual, mark the month closed |
| **P&L Statement** | Formal monthly income statement with budget vs. actual, CSV export, print/PDF |
| **Balance Sheet** | What the business owns and owes, by section |
| **Year-End** | Banked months plus a labelled projection for the rest, and a CSV pack for the accountant |
| **Inventory Buys** | Log card-show / collection purchases so COGS and margins stay honest |
| **Chart of Accounts** | Manage accounts, P&L/Balance Sheet sections, fixed vs. variable tagging |
| **Square Reports** | Upload the monthly Square Sales Report email (.eml) — parsed automatically |
| **Settings** | Cash balance, COGS method and rates, purchasing guardrail, count history, budgets |
| **How Your Books Work** | Plain-English guide to the retail cash cycle and why inventory isn't an expense |

## Setup

1. **Install and configure**

   ```sh
   npm install
   cp .env.example .env   # then fill in your Supabase URL + anon key
   ```

2. **Run the database migration (one time)**

   Open Supabase dashboard → SQL Editor → paste the contents of
   [`supabase/migration.sql`](supabase/migration.sql) → Run.

   This adds the `pl_section` / `parent` / `cost_type` columns, creates the
   `client_settings` and `inventory_buys` tables, and enables Row Level
   Security so the anon key alone can't read or write anything.

3. **Enable sign-in — and lock out everyone else**

   Supabase dashboard → Authentication:

   1. Make sure the **Email** provider is enabled (magic links). The app
      emails you a one-time sign-in link — no password.
   2. Create the owner's account: **Users → Add user** with your email.
      (The app requests links with `shouldCreateUser: false`, so unknown
      emails are rejected — the account must exist first.)
   3. Turn **off** "Allow new users to sign up". The RLS policies trust
      *every* signed-in user, so if signups stay open, anyone who finds the
      URL could create an account and read/write all your data.

   For local development before auth is set up, put
   `NEXT_PUBLIC_DISABLE_AUTH=true` in `.env` (never deploy with this on).

   ⚠️ The Supabase **service key** (`SUPABASE_SERVICE_KEY` in `.env`) bypasses
   Row Level Security. Never give it a `NEXT_PUBLIC_` prefix and never import
   it in client code.

4. **Run it**

   ```sh
   npm run dev
   ```

## Monthly close routine (~30 minutes)

Work through **Month-End Close** (`/close`) — it picks the month, shows each step's live status
and links to the page that resolves it:

1. Download last month's bank CSV(s) and import on **Transactions**.
2. Save last month's Square Sales Report email as `.eml` and upload it on **Square Reports**.
3. Clear the **Uncategorized** filter on Transactions (accept suggestions, categorize the rest).
4. Book the COGS estimate and the sales-tax accrual — one button on the close page.
5. Log any cash buys from shows on **Inventory Buys**.
6. Update the cash balance in **Settings** (or the Dashboard runway card).

Then mark the month closed. Quarter ends add an inventory-count step; the count itself is
recorded on the Dashboard's Inventory card because it books a true-up entry.

## Notes

- `.env` is gitignored — never commit Supabase credentials.
- Account classifications live in the `categories` table after the migration;
  a warning banner appears on Chart of Accounts while they're still browser-local.
- Renaming a category updates every transaction that uses it; deleting one
  offers to reassign its transactions.
- `npm run build` / `npm run lint` before deploying.
