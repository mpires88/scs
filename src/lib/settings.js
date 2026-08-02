import { supabase, isMissingSchemaError } from './supabase'

// Key/value settings backed by the client_settings table (see supabase/migration.sql).
// Falls back to localStorage until the migration has been run, so the app
// never breaks — values just stay per-browser until then.

let tableReady = null

async function settingsReady() {
  if (tableReady !== null) return tableReady
  const { error } = await supabase.from('client_settings').select('key').limit(1)
  if (!error) tableReady = true
  else if (isMissingSchemaError(error)) tableReady = false
  else throw error // transient failure — don't cache a verdict
  return tableReady
}

const lsKey = key => `scs_setting_${key}`

export async function getSetting(clientId, key, fallback = null) {
  if (await settingsReady()) {
    const { data, error } = await supabase.from('client_settings')
      .select('value').eq('client_id', clientId).eq('key', key).maybeSingle()
    if (!error && data) return data.value ?? fallback
    return fallback
  }
  try {
    const raw = localStorage.getItem(lsKey(key))
    return raw != null ? JSON.parse(raw) : fallback
  } catch { return fallback }
}

export async function setSetting(clientId, key, value) {
  if (await settingsReady()) {
    const { error } = await supabase.from('client_settings')
      .upsert({ client_id: clientId, key, value, updated_at: new Date().toISOString() },
              { onConflict: 'client_id,key' })
    if (error) throw error
    return
  }
  localStorage.setItem(lsKey(key), JSON.stringify(value))
}
