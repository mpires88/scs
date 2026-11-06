'use client'

import ProjectionsPlanner from '../../components/ProjectionsPlanner'
import { CLIENT_ID } from '../../lib/client'

export default function ProjectionsPage() {
  return <ProjectionsPlanner clientId={CLIENT_ID} />
}
