'use client'

import HolidayPlanner from '../../components/HolidayPlanner'
import { CLIENT_ID } from '../../lib/client'

export default function PlannerPage() {
  return <HolidayPlanner clientId={CLIENT_ID} />
}
