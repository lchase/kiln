import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { readJournal, runTagFromJournal } from '../../engine/journal.js'
import { defaultRunsDir } from '../../engine/run.js'
import { openRequestStepIds, readPendingRequest } from '../../engine/suspend.js'

export interface PendingOptions {
  runsDir?: string
}

/**
 * M4 ticket 03: a run counts as pending iff its journal's last event is
 * `run.finished` with `status: 'suspended'` — `executeWorkflowFile` and
 * `resumeRun` both always append a terminal `run.finished` regardless of
 * outcome, so the discriminant is that event's `status` field, not its
 * presence. Either way, the journal is authoritative, not
 * `pending/*.request.json`/`.answer.json` file presence, which lingers
 * indefinitely once a run resumes or finishes.
 */
export async function pendingCommand(opts: PendingOptions = {}): Promise<number> {
  const runsDir = opts.runsDir ?? defaultRunsDir()
  const runIds = (await readdir(runsDir).catch(() => [] as string[])).sort()

  let anyPending = false

  for (const runId of runIds) {
    const runDir = path.join(runsDir, runId)
    const events = await readJournal(runDir)
    const last = events.at(-1)
    if (!last || last.t !== 'run.finished' || last.status !== 'suspended') continue

    anyPending = true
    const tag = runTagFromJournal(events)
    console.log(`run ${runId} suspended${tag !== undefined ? ` (tag: ${tag})` : ''}:`)

    const openIds = openRequestStepIds(events)
    if (openIds.length === 0) {
      console.log('  (no open request found — loop budget suspend from before M4, unresumable)')
      continue
    }

    for (const stepId of openIds) {
      const request = await readPendingRequest(runDir, stepId)
      if (!request) {
        console.log(`  ${stepId}: (request file missing)`)
        continue
      }
      if (request.kind === 'gate') {
        console.log(`  ${stepId} (gate): ${request.rendered.split('\n')[0]}`)
      } else {
        console.log(`  ${stepId} (loop exhausted): tripped ${request.tripped} at iteration ${request.iteration}`)
      }
    }
  }

  if (!anyPending) console.log('nothing pending')
  return 0
}
