import path from 'node:path'
import { listMapItemArtifacts } from '../../engine/artifacts.js'
import { defaultRunsDir, findLatestRunId, readRunWorkflow } from '../../engine/run.js'

export interface ArtifactsOptions {
  runsDir?: string
}

/** Ticket 09: `yak artifacts` — for each `map` step in the workflow, list
 * which item indices currently have a file on disk. Read straight from
 * `artifacts/`, so a partial fan-out (a live or interrupted run) shows
 * exactly the items that landed so far, not just a finished run's
 * assembled array. */
export async function artifactsCommand(runId: string | undefined, opts: ArtifactsOptions = {}): Promise<number> {
  const runsDir = opts.runsDir ?? defaultRunsDir()
  const resolvedRunId = runId ?? (await findLatestRunId(runsDir))

  if (!resolvedRunId) {
    console.error('no runs found')
    return 1
  }

  const runDir = path.join(runsDir, resolvedRunId)
  const workflow = await readRunWorkflow(runDir).catch(() => undefined)
  if (!workflow) {
    console.error(`run ${resolvedRunId} not found`)
    return 1
  }

  console.log(`run ${resolvedRunId}:`)
  const mapSteps = workflow.steps.filter((s) => s.kind === 'map' && s.produces)
  if (mapSteps.length === 0) {
    console.log('  (no map steps with a produced artifact)')
    return 0
  }

  for (const step of mapSteps) {
    const indices = await listMapItemArtifacts(runDir, step.produces!)
    console.log(`  ${step.id} (${step.produces}): items [${indices.join(', ')}]`)
  }

  return 0
}
