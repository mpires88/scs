'use client'

import HelpGuide from '../../components/HelpGuide'
import { CLIENT_ID } from '../../lib/client'

export default function HelpPage() {
  return <HelpGuide clientId={CLIENT_ID} />
}
