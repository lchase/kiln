import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ArtifactName, JournalEnvelope, JournalEvent, StepId } from '../ir/types.js'

function journalPath(runDir: string): string {
  return path.join(runDir, 'journal.jsonl')
}

export async function appendJournalEvent(
  runDir: string,
  runId: string,
  event: JournalEvent,
): Promise<void> {
  const envelope: JournalEnvelope = { ...event, at: new Date().toISOString(), runId }
  await mkdir(runDir, { recursive: true })
  await appendFile(journalPath(runDir), `${JSON.stringify(envelope)}\n`, 'utf8')
}

export async function readJournal(runDir: string): Promise<JournalEnvelope[]> {
  const contents = await readFile(journalPath(runDir), 'utf8').catch(() => '')
  return contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEnvelope)
}

/** yak#22: the caller-supplied `--tag` carried on `run.started`, or
 * `undefined` when the run was launched without one. */
export function runTagFromJournal(events: JournalEnvelope[]): string | undefined {
  const started = events.find((e) => e.t === 'run.started')
  return started?.t === 'run.started' ? started.tag : undefined
}

/** A step whose most recent journal state, as of replay, is `step.completed`. */
export interface ReplayedStep {
  stepId: StepId
  semanticKey: string
  definitionKey: string
  artifact?: ArtifactName
  artifactHash?: string
}

/**
 * Spec §13 "Engine loop": replay journal -> completed set. A step that has
 * `step.started` with no later `step.completed`/`step.failed` (interrupted
 * mid-flight) is not completed. Keyed by stepId, so a later `step.started`
 * for the same id (re-run) resets its completion.
 */
export function completedStepsFromJournal(events: JournalEnvelope[]): Map<StepId, ReplayedStep> {
  const started = new Map<StepId, { semanticKey: string; definitionKey: string }>()
  const completed = new Map<StepId, ReplayedStep>()

  for (const event of events) {
    if (event.t === 'step.started') {
      started.set(event.stepId, { semanticKey: event.semanticKey, definitionKey: event.definitionKey })
      completed.delete(event.stepId)
    } else if (event.t === 'step.completed') {
      const info = started.get(event.stepId)
      if (info) {
        completed.set(event.stepId, {
          stepId: event.stepId,
          semanticKey: info.semanticKey,
          definitionKey: info.definitionKey,
          ...(event.artifact !== undefined ? { artifact: event.artifact } : {}),
          ...(event.artifactHash !== undefined ? { artifactHash: event.artifactHash } : {}),
        })
      }
    } else if (event.t === 'step.failed') {
      completed.delete(event.stepId)
    }
  }

  return completed
}
