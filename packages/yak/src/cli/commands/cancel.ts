import { cancelRun } from '../../engine/cancel.js'

export interface CancelCommandOptions {
  runsDir?: string
}

export async function cancelCommand(runId: string, opts: CancelCommandOptions = {}): Promise<number> {
  const outcome = await cancelRun(runId, { runsDir: opts.runsDir })

  switch (outcome.status) {
    case 'not-found':
      console.error(`run ${runId} not found`)
      return 1
    case 'already-terminal':
      console.log(`run ${runId} already finished: ${outcome.finishedStatus} — nothing to cancel`)
      return 0
    case 'cancelled': {
      const note =
        outcome.signalled === 'no-pid'
          ? ' (no pid recorded — marked cancelled without signalling)'
          : outcome.signalled === 'not-running'
            ? ' (process already gone — marked cancelled)'
            : outcome.signalled === 'sigkill'
              ? ' (SIGKILL after grace period)'
              : ''
      console.log(`run ${runId} cancelled${note}`)
      return 0
    }
  }
}
