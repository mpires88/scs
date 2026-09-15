import { supabase } from './supabase'

// Vendors — who SCS buys from. One `vendors` row per vendor; a transaction
// points at one through bank_transactions.vendor_id (supabase/migration.sql §7).
// Names are unique per client case-insensitively, so a typed name resolves to
// at most one vendor and "Costco" can't be created next to "COSTCO".

const COLS = 'id, name, notes, created_at'

export async function fetchVendors(clientId) {
  const { data, error } = await supabase.from('vendors')
    .select(COLS).eq('client_id', clientId).order('name')
  if (error) throw error
  return data ?? []
}

export function findVendorByName(vendors, name) {
  const q = (name || '').trim().toLowerCase()
  if (!q) return null
  return vendors.find(v => (v.name || '').toLowerCase() === q) ?? null
}

// Creates the vendor, or returns the existing one when the name is already
// taken — two rows typed "Uline" a moment apart must not end in an error.
export async function addVendor(clientId, name) {
  const clean = (name || '').trim()
  if (!clean) throw new Error('Vendor name is required')
  const { data, error } = await supabase.from('vendors')
    .insert({ client_id: clientId, name: clean }).select(COLS).single()
  if (!error) return data
  if (error.code === '23505') {
    // ilike treats % and _ as wildcards; escape them so the lookup is exact.
    const pattern = clean.replace(/[\\%_]/g, m => '\\' + m)
    const { data: existing, error: e2 } = await supabase.from('vendors')
      .select(COLS).eq('client_id', clientId).ilike('name', pattern).maybeSingle()
    if (e2) throw e2
    if (existing) return existing
  }
  throw error
}

export async function renameVendor(clientId, id, name) {
  const clean = (name || '').trim()
  if (!clean) throw new Error('Vendor name is required')
  const { error } = await supabase.from('vendors')
    .update({ name: clean }).eq('client_id', clientId).eq('id', id)
  if (error) throw error
}

export async function setVendorNotes(clientId, id, notes) {
  const { error } = await supabase.from('vendors')
    .update({ notes: (notes || '').trim() || null }).eq('client_id', clientId).eq('id', id)
  if (error) throw error
}

// The foreign key is ON DELETE SET NULL: the vendor's transactions stay and
// simply become unassigned.
export async function deleteVendor(clientId, id) {
  const { error } = await supabase.from('vendors')
    .delete().eq('client_id', clientId).eq('id', id)
  if (error) throw error
}

// Points the given transactions at a vendor (or at none with null). Written
// straight away rather than through the category autosave queue: a vendor is
// a label, not a figure on the books, so there's nothing to hold back.
export async function setVendorOnTransactions(clientId, ids, vendorId) {
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await supabase.from('bank_transactions')
      .update({ vendor_id: vendorId ?? null })
      .eq('client_id', clientId).in('id', ids.slice(i, i + 500))
    if (error) throw error
  }
}
