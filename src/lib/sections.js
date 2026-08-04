// Statement section names — split out of chartOfAccounts.js so pure libs and
// tests can import them without pulling in the supabase client.

export const PL_SECTIONS = [
  'Revenue',
  'Deductions to Income',
  'Cost of Goods Sold',
  'Operating Expenses',
  'Non-Operating Income',
  'Non-Operating Expenses',
]

export const BS_SECTIONS = [
  'Current Assets',
  'Non-Current Assets',
  'Current Liabilities',
  'Non-Current Liabilities',
  'Equity',
]

export const ALL_SECTIONS = [...PL_SECTIONS, ...BS_SECTIONS]

export const isPLSection = s => PL_SECTIONS.includes(s)
export const isBSSection = s => BS_SECTIONS.includes(s)

export const ASSET_SECTIONS = new Set(['Current Assets', 'Non-Current Assets'])
