'use client'

import Dashboard from '../components/Dashboard'
import { CLIENT_ID } from '../lib/client'

export default function DashboardPage() {
  return <Dashboard clientId={CLIENT_ID} />
}
