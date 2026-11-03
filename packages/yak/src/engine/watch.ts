import { flattenSteps } from '../ir/graph.js'
import type { JournalEnvelope, Step, StepId, Workflow } from '../ir/types.js'
import { readJournal } from './journal.js'
import { loopStatusFromJournal, stepStatusesFromJournal } from './status.js'
import type { LoopStatusDetail, StepStatus } from './status.js'
import { openRequestStepIds } from './suspend.js'

export interface WatchSnapshot {
  stepStatuses: StepStatus[]
  loopStatuses: LoopStatusDetail[]
  openGateIds: StepId[]
  runStatus?: 'ok' | 'failed' | 'suspended'
}

function isLoopStep(step: Step): step is Extract<Step, { kind: 'loop' }> {
  return step.kind === 'loop'
}

/** t05: `yak watch`'s data source — reuses `stepStatusesFromJournal` and
 * `loopStatusFromJournal` directly rather than a new event-streaming
 * abstraction, matching spec §4.2 ("the TUI tails it, observability is
 * `tail -f`, not an integration"). Pure: same journal in, same snapshot
 * out, independent of how often or how it's re-read. */
export function snapshotFromJournal(workflow: Workflow, events: JournalEnvelope[]): WatchSnapshot {
  const stepStatuses = stepStatusesFromJournal(workflow.steps, events)
  const loopStatuses = flattenSteps(workflow.steps).filter(isLoopStep).map((step) => loopStatusFromJournal(step, events))
  const openGateIds = openRequestStepIds(events)

  const finishedEvent = [...events].reverse().find((e) => e.t === 'run.finished')
  const runStatus = finishedEvent?.t === 'run.finished' ? finishedEvent.status : undefined

  return { stepStatuses, loopStatuses, openGateIds, ...(runStatus !== undefined ? { runStatus } : {}) }
}

export interface WatchDeps {
  readJournal: (runDir: string) => Promise<JournalEnvelope[]>
  sleep: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Polls the run's journal file, re-parsing on every tick and calling
 * `onSnapshot` only when the snapshot actually changed since the last tick
 * — exits once the run finishes or suspends (a `run.finished` event of any
 * status appears; `'suspended'` is itself a terminal `run.finished` status,
 * spec §4.4). `deps` is the seam this is unit-tested through: a fake
 * `readJournal` scripts successive polls without touching the filesystem or
 * real timers.
 */
export async function watchRun(
  runDir: string,
  workflow: Workflow,
  onSnapshot: (snapshot: WatchSnapshot) => void,
  intervalMs = 300,
  deps: WatchDeps = { readJournal, sleep: defaultSleep },
): Promise<WatchSnapshot> {
  let lastSerialized: string | undefined

  for (;;) {
    const events = await deps.readJournal(runDir)
    const snapshot = snapshotFromJournal(workflow, events)
    const serialized = JSON.stringify(snapshot)

    if (serialized !== lastSerialized) {
      onSnapshot(snapshot)
      lastSerialized = serialized
    }

    if (snapshot.runStatus !== undefined) return snapshot
    await deps.sleep(intervalMs)
  }
}
