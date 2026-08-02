import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

// True when an error means a table/column from supabase/migration.sql doesn't
// exist yet — as opposed to a transient network/auth failure, which callers
// should surface rather than treat as "migration not run".
export function isMissingSchemaError(error) {
  if (!error) return false
  if (['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code)) return true
  return /does not exist|schema cache/i.test(error.message || '')
}

// Fetch every row of a query, paging past Supabase's 1,000-row response cap.
// `buildQuery` must return a fresh query each call (e.g. () => supabase.from(...).select(...).eq(...)).
export async function fetchAll(buildQuery, pageSize = 1000) {
  let all = [], offset = 0
  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1)
    if (error) throw error
    if (!data?.length) break
    all = all.concat(data)
    if (data.length < pageSize) break
    offset += pageSize
  }
  return all
}
