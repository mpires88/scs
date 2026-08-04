import { supabase, isMissingSchemaError } from './supabase'

// Section constants live in sections.js (supabase-free for pure libs/tests);
// re-exported here so existing imports keep working.
export { PL_SECTIONS, BS_SECTIONS, ALL_SECTIONS, isPLSection, isBSSection } from './sections'

const DEFAULT_PL_ACCOUNTS = [
  // Revenue
  { name: 'Sales',                                  pl_section: 'Revenue',                sort_order: 10  },
  { name: 'Sales Tax Collected',                    pl_section: 'Deductions to Income',   sort_order: 50  },

  // Cost of Goods Sold
  { name: 'COGS - Product',                         pl_section: 'Cost of Goods Sold',     sort_order: 100 },
  { name: 'COGS - Shipping',                        pl_section: 'Cost of Goods Sold',     sort_order: 110 },

  // Operating Expenses
  { name: 'Advertising & Marketing',                pl_section: 'Operating Expenses',     sort_order: 200, cost_type: 'variable' },
  { name: 'Bank & Credit Card Fees',                pl_section: 'Operating Expenses',     sort_order: 210, cost_type: 'variable' },
  { name: 'Business Expenses',                      pl_section: 'Operating Expenses',     sort_order: 220 },
  { name: 'Donations',                              pl_section: 'Operating Expenses',     sort_order: 225 },
  { name: 'Insurance',                              pl_section: 'Operating Expenses',     sort_order: 230, cost_type: 'fixed' },
  { name: 'Legal & Professional Services',          pl_section: 'Operating Expenses',     sort_order: 240 },
  { name: 'Meals & Entertainment',                  pl_section: 'Operating Expenses',     sort_order: 250 },
  { name: 'Miscellaneous',                          pl_section: 'Operating Expenses',     sort_order: 260 },
  { name: 'Office Expense',                         pl_section: 'Operating Expenses',     sort_order: 270 },
  { name: 'Payroll & Wages',                        pl_section: 'Operating Expenses',     sort_order: 280, cost_type: 'fixed' },
  { name: 'Payroll Taxes',                          pl_section: 'Operating Expenses',     sort_order: 290, cost_type: 'fixed' },
  { name: "Worker's Compensation",                  pl_section: 'Operating Expenses',     sort_order: 300, cost_type: 'fixed' },
  { name: 'Rent or Lease',                          pl_section: 'Operating Expenses',     sort_order: 310, cost_type: 'fixed' },
  { name: 'Repairs & Maintenance',                  pl_section: 'Operating Expenses',     sort_order: 320 },
  { name: 'Sales Taxes Paid',                       pl_section: 'Operating Expenses',     sort_order: 330, cost_type: 'variable' },
  { name: 'Security',                               pl_section: 'Operating Expenses',     sort_order: 335, cost_type: 'fixed' },
  { name: 'Supplies & Materials',                   pl_section: 'Operating Expenses',     sort_order: 340, cost_type: 'variable' },
  { name: 'Travel Expenses',                        pl_section: 'Operating Expenses',     sort_order: 350 },
  { name: 'Utilities & Phone',                      pl_section: 'Operating Expenses',     sort_order: 360, cost_type: 'fixed' },
  { name: 'Depreciation - Leasehold Improvements', pl_section: 'Operating Expenses',     sort_order: 370, cost_type: 'fixed' },
  { name: 'Depreciation - FF&E',                   pl_section: 'Operating Expenses',     sort_order: 380, cost_type: 'fixed' },

  // Non-Operating Income
  { name: 'Interest Income',                        pl_section: 'Non-Operating Income',   sort_order: 400 },
  { name: 'Other Income',                           pl_section: 'Non-Operating Income',   sort_order: 410 },

  // Non-Operating Expenses
  { name: 'Interest Charges',                       pl_section: 'Non-Operating Expenses', sort_order: 500 },
  { name: 'Other Expense',                          pl_section: 'Non-Operating Expenses', sort_order: 510 },
  { name: 'Amortization - Other Startup Expenses',  pl_section: 'Non-Operating Expenses', sort_order: 520 },
]

const DEFAULT_BS_ACCOUNTS = [
  // Current Assets
  { name: 'Cash & Bank Accounts',                              pl_section: 'Current Assets',          sort_order: 600 },
  { name: 'Accounts Receivable',                               pl_section: 'Current Assets',          sort_order: 610 },
  { name: 'Inventory',                                         pl_section: 'Current Assets',          sort_order: 620 },
  { name: 'Prepaid Expenses',                                  pl_section: 'Current Assets',          sort_order: 630 },

  // Non-Current Assets (Fixed & Other)
  { name: 'Leasehold Improvements',                            pl_section: 'Non-Current Assets',      sort_order: 700 },
  { name: 'Furniture, Fixtures & Equipment',                   pl_section: 'Non-Current Assets',      sort_order: 710 },
  { name: 'Accumulated Depreciation - LI',                     pl_section: 'Non-Current Assets',      sort_order: 720 },
  { name: 'Accumulated Depreciation - FF&E',                   pl_section: 'Non-Current Assets',      sort_order: 730 },
  { name: 'Security Deposits',                                 pl_section: 'Non-Current Assets',      sort_order: 740 },
  { name: 'Other Startup Expenses',                            pl_section: 'Non-Current Assets',      sort_order: 750 },
  { name: 'Accumulated Amortization - Other Startup Expenses', pl_section: 'Non-Current Assets',      sort_order: 760 },

  // Current Liabilities
  { name: 'Accounts Payable',                                  pl_section: 'Current Liabilities',     sort_order: 800 },
  { name: 'Credit Card Payable',                               pl_section: 'Current Liabilities',     sort_order: 810 },
  { name: 'Sales Tax Payable',                                 pl_section: 'Current Liabilities',     sort_order: 820 },
  { name: 'Payroll Liabilities',                               pl_section: 'Current Liabilities',     sort_order: 830 },

  // Non-Current Liabilities
  { name: 'Long-Term Debt',                                    pl_section: 'Non-Current Liabilities', sort_order: 900 },

  // Equity
  { name: "Owner's Equity",                                    pl_section: 'Equity',                  sort_order: 1000 },
  { name: "Owner's Draw",                                      pl_section: 'Equity',                  sort_order: 1005 },
  { name: 'Additional Paid-in Capital',                        pl_section: 'Equity',                  sort_order: 1010 },
  { name: 'Retained Earnings',                                 pl_section: 'Equity',                  sort_order: 1020 },
]

export const DEFAULT_ACCOUNTS = [...DEFAULT_PL_ACCOUNTS, ...DEFAULT_BS_ACCOUNTS]

export function defaultSectionFor(name) {
  return DEFAULT_ACCOUNTS.find(a => a.name === name)?.pl_section ?? 'Operating Expenses'
}

// ─── Legacy localStorage maps (pre-migration fallback) ────────────────────────

const LS_KEY = 'scs_pl_sections'
const LS_PARENT_KEY = 'scs_parents'

const loadLS = key => { try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} } }
const saveLS = (key, map) => localStorage.setItem(key, JSON.stringify(map))

// ─── Schema detection ─────────────────────────────────────────────────────────
// Until supabase/migration.sql has been run, the pl_section/parent/cost_type
// columns don't exist. Detect once per session and fall back to localStorage.

let schemaReady = null

export async function coaSchemaReady() {
  if (schemaReady !== null) return schemaReady
  const { error } = await supabase.from('categories').select('pl_section').limit(1)
  if (!error) schemaReady = true
  else if (isMissingSchemaError(error)) schemaReady = false
  else throw error // transient failure — don't cache a verdict
  return schemaReady
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
// Returns { accounts, legacy }. In DB mode, silently backfills any accounts
// whose pl_section is null (one-time migration from localStorage/defaults).

export async function fetchAccounts(clientId) {
  const ready = await coaSchemaReady()

  if (!ready) {
    const { data, error } = await supabase
      .from('categories').select('name, sort_order')
      .eq('client_id', clientId).order('sort_order')
    if (error) throw error
    const secMap = loadLS(LS_KEY), parMap = loadLS(LS_PARENT_KEY)
    return {
      legacy: true,
      accounts: (data ?? []).map(r => ({
        ...r,
        pl_section: secMap[r.name] ?? defaultSectionFor(r.name),
        parent:     parMap[r.name] ?? null,
        cost_type:  null,
      })),
    }
  }

  const { data, error } = await supabase
    .from('categories').select('name, sort_order, pl_section, parent, cost_type')
    .eq('client_id', clientId).order('sort_order')
  if (error) throw error
  const rows = data ?? []

  // Backfill null sections from localStorage (old installs) or defaults
  const secMap = loadLS(LS_KEY)
  const needsSection = rows.filter(r => !r.pl_section)
  if (needsSection.length) {
    needsSection.forEach(r => { r.pl_section = secMap[r.name] ?? defaultSectionFor(r.name) })
    const bySec = {}
    needsSection.forEach(r => { (bySec[r.pl_section] ??= []).push(r.name) })
    await Promise.all(Object.entries(bySec).map(([sec, names]) =>
      supabase.from('categories').update({ pl_section: sec })
        .eq('client_id', clientId).in('name', names)
    ))
  }

  // Backfill parents from localStorage once
  const parMap = loadLS(LS_PARENT_KEY)
  const needsParent = rows.filter(r => !r.parent && parMap[r.name])
  if (needsParent.length) {
    needsParent.forEach(r => { r.parent = parMap[r.name] })
    await Promise.all(needsParent.map(r =>
      supabase.from('categories').update({ parent: r.parent })
        .eq('client_id', clientId).eq('name', r.name)
    ))
  }

  return { legacy: false, accounts: rows }
}

export async function fetchSectionMap(clientId) {
  const { accounts, legacy } = await fetchAccounts(clientId)
  const map = {}
  accounts.forEach(a => { map[a.name] = a.pl_section })
  return { map, accounts, legacy }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function addAccount(clientId, { name, section, parent, sortOrder }) {
  const ready = await coaSchemaReady()
  const row = { client_id: clientId, name, sort_order: sortOrder }
  if (ready) { row.pl_section = section; row.parent = parent || null }
  const { error } = await supabase.from('categories').insert(row)
  if (error) throw error
  if (!ready) {
    const m = loadLS(LS_KEY); m[name] = section; saveLS(LS_KEY, m)
    if (parent) { const p = loadLS(LS_PARENT_KEY); p[name] = parent; saveLS(LS_PARENT_KEY, p) }
  }
}

export async function setSection(clientId, name, section) {
  const ready = await coaSchemaReady()
  if (!ready) { const m = loadLS(LS_KEY); m[name] = section; saveLS(LS_KEY, m); return }
  const { error } = await supabase.from('categories')
    .update({ pl_section: section }).eq('client_id', clientId).eq('name', name)
  if (error) throw error
}

export async function setParent(clientId, name, parent) {
  const ready = await coaSchemaReady()
  if (!ready) {
    const p = loadLS(LS_PARENT_KEY)
    if (parent) p[name] = parent; else delete p[name]
    saveLS(LS_PARENT_KEY, p); return
  }
  const { error } = await supabase.from('categories')
    .update({ parent: parent || null }).eq('client_id', clientId).eq('name', name)
  if (error) throw error
}

export async function setCostType(clientId, name, costType) {
  const ready = await coaSchemaReady()
  if (!ready) return // fixed/variable tagging requires the migration
  const { error } = await supabase.from('categories')
    .update({ cost_type: costType || null }).eq('client_id', clientId).eq('name', name)
  if (error) throw error
}

// Rename an account AND cascade to transactions + child accounts, so nothing
// silently drops off the P&L.
export async function renameAccount(clientId, oldName, newName) {
  const ready = await coaSchemaReady()
  const { error } = await supabase.from('categories')
    .update({ name: newName }).eq('client_id', clientId).eq('name', oldName)
  if (error) throw error

  const { error: txErr } = await supabase.from('bank_transactions')
    .update({ category: newName }).eq('client_id', clientId).eq('category', oldName)
  if (txErr) throw txErr

  if (ready) {
    await supabase.from('categories')
      .update({ parent: newName }).eq('client_id', clientId).eq('parent', oldName)
  } else {
    const secMap = loadLS(LS_KEY)
    if (secMap[oldName]) { secMap[newName] = secMap[oldName]; delete secMap[oldName]; saveLS(LS_KEY, secMap) }
    const parMap = loadLS(LS_PARENT_KEY)
    Object.keys(parMap).forEach(k => { if (parMap[k] === oldName) parMap[k] = newName })
    if (parMap[oldName]) { parMap[newName] = parMap[oldName]; delete parMap[oldName] }
    saveLS(LS_PARENT_KEY, parMap)
  }
}

// Delete an account. Transactions are first reassigned to `reassignTo`
// (or set uncategorized when null); children become top-level.
export async function deleteAccount(clientId, name, reassignTo = null) {
  const ready = await coaSchemaReady()

  const { error: txErr } = await supabase.from('bank_transactions')
    .update({ category: reassignTo }).eq('client_id', clientId).eq('category', name)
  if (txErr) throw txErr

  const { error } = await supabase.from('categories')
    .delete().eq('client_id', clientId).eq('name', name)
  if (error) throw error

  if (ready) {
    await supabase.from('categories')
      .update({ parent: null }).eq('client_id', clientId).eq('parent', name)
  } else {
    const secMap = loadLS(LS_KEY); delete secMap[name]; saveLS(LS_KEY, secMap)
    const parMap = loadLS(LS_PARENT_KEY)
    delete parMap[name]
    Object.keys(parMap).forEach(k => { if (parMap[k] === name) delete parMap[k] })
    saveLS(LS_PARENT_KEY, parMap)
  }
}

// Count how many transactions currently use a category (for the delete flow).
export async function countTransactionsUsing(clientId, name) {
  const { count, error } = await supabase.from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('category', name)
  if (error) throw error
  return count ?? 0
}

export async function seedDefaults(clientId) {
  const ready = await coaSchemaReady()
  const rows = DEFAULT_ACCOUNTS.map(a => ({
    client_id: clientId, name: a.name, sort_order: a.sort_order,
    ...(ready ? { pl_section: a.pl_section, cost_type: a.cost_type ?? null } : {}),
  }))
  const { error } = await supabase.from('categories').upsert(rows, { onConflict: 'name' })
  if (error) throw error
  if (!ready) {
    const m = loadLS(LS_KEY)
    DEFAULT_ACCOUNTS.forEach(a => { if (!m[a.name]) m[a.name] = a.pl_section })
    saveLS(LS_KEY, m)
  }
}
