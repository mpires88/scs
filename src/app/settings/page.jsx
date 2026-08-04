'use client'

import Settings from '../../components/Settings'
import { CLIENT_ID } from '../../lib/client'

export default function SettingsPage() {
  return <Settings clientId={CLIENT_ID} />
}
