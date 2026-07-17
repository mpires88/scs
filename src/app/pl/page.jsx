'use client'

import ReportsPL from '../../components/ReportsPL'
import { CLIENT_ID } from '../../lib/client'

export default function PLStatementPage() {
  return <ReportsPL clientId={CLIENT_ID} />
}
