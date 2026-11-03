import { readJournal } from '../../engine/journal.js'
import { resumeRun } from '../../engine/run.js'
import { failedStepsFromJournal, formatStepFailure } from '../../engine/status.js'
import type { AdapterId } from '../../ir/types.js'

const EX_SUSPEND = 78

export async function resumeCommand(runId: string, adapter?: AdapterId): Promise<number> {
  let result: Awaited<ReturnType<typeof resumeRun>>
  try {
    result = await resumeRun(runId, { adapter })
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }

  if (result.status === 'ok') {
    console.log(`run ${result.runId} finished: ok`)
    return 0
  }

  if (result.status === 'suspended') {
    console.log(`run ${result.runId} suspended — resume with:\n  yak resume ${result.runId}`)
    return EX_SUSPEND
  }

  console.error(`run ${result.runId} failed:`)
  const events = await readJournal(result.runDir)
  for (const { stepId, failure } of failedStepsFromJournal(events)) {
    console.error(`  ${stepId}: ${formatStepFailure(failure)}`)
  }
  return 1
}
