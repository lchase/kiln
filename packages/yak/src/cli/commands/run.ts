import path from 'node:path'
import { cancel, intro, log, outro } from '@clack/prompts'
import { readJournal } from '../../engine/journal.js'
import { executeWorkflowFile, readRunWorkflow, resumeRun } from '../../engine/run.js'
import { failedStepsFromJournal, formatStepFailure } from '../../engine/status.js'
import { openRequestStepIds, readPendingRequest, writeAnswer } from '../../engine/suspend.js'
import type { AdapterId, RunIsolation } from '../../ir/types.js'
import { clackFieldPrompt, lineFieldPrompt, promptForAnswer, PromptCancelledError } from '../interactive.js'

const EX_SUSPEND = 78

export interface RunCommandOptions {
  adapter?: AdapterId
  interactive?: boolean
  isolation?: RunIsolation
  /** `yak run --input key=value` map (yak#27), validated against the
   * workflow's `inputSchema`. */
  input?: Record<string, unknown>
  /** `yak run --tag <string>` (yak#22): opaque caller correlation tag. */
  tag?: string
  /** `yak run --isolation worktree --from <ref>`: revision the run
   * worktree is forked from. Requires worktree isolation. */
  from?: string
}

/**
 * M4 ticket 09: when a round suspends with multiple gates open at once,
 * `--interactive` prompts through all of them in one invocation, in
 * workflow declaration order — not the order the scheduler happened to
 * open them in, which can vary with concurrency.
 */
async function answerOpenRequestsInteractively(runId: string, runDir: string): Promise<void> {
  const events = await readJournal(runDir)
  const openIds = new Set(openRequestStepIds(events))
  if (openIds.size === 0) return

  const workflow = await readRunWorkflow(runDir)
  const orderedIds = workflow.steps.map((s) => s.id).filter((id) => openIds.has(id))

  // clack's widgets need a real TTY to read keystrokes from — piped or
  // redirected stdin (scripts, CI) falls back to the plain line-based
  // prompt instead of misreading answer bytes as keypresses.
  const isRealTerminal = process.stdin.isTTY && process.stdout.isTTY
  const { promptField, close } = isRealTerminal
    ? { promptField: clackFieldPrompt(), close: () => {} }
    : lineFieldPrompt(process.stdin, process.stdout)
  const announce = isRealTerminal ? log.info : (text: string) => console.log(`\n${text}\n`)

  if (isRealTerminal) intro('yak: answer pending gates')
  try {
    for (const stepId of orderedIds) {
      const request = await readPendingRequest(runDir, stepId)
      if (!request) continue
      try {
        const answer = await promptForAnswer(request, promptField, announce)
        await writeAnswer(runDir, stepId, answer)
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          cancel(`"${stepId}" left unanswered — run still suspended`)
          throw new Error(`answering "${stepId}" was cancelled`)
        }
        throw err
      }
    }
  } finally {
    close()
  }
  if (isRealTerminal) outro('all gates answered')
}

export async function runCommand(workflowPath: string, opts: RunCommandOptions = {}): Promise<number> {
  let result: Awaited<ReturnType<typeof executeWorkflowFile>>
  try {
    result = await executeWorkflowFile(path.resolve(workflowPath), {
      adapter: opts.adapter,
      isolation: opts.isolation,
      input: opts.input,
      tag: opts.tag,
      from: opts.from,
      // yak#23: emit the run id (and worktree branch) to stderr the moment
      // `run.started` is journalled, so an out-of-process launcher can
      // capture it without waiting for a terminal state. stdout is
      // untouched — the terminal-state line there is unchanged.
      onStart: ({ runId, worktreeBranch }) => {
        console.error(`run ${runId} started`)
        if (worktreeBranch) console.error(`  worktree branch ${worktreeBranch}`)
      },
    })

    while (opts.interactive && result.status === 'suspended') {
      await answerOpenRequestsInteractively(result.runId, result.runDir)
      result = await resumeRun(result.runId, { adapter: opts.adapter })
    }
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
