import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { CommandStep, StepFailure } from '../ir/types.js'

export const CommandResultSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().optional(),
})
export type CommandResult = z.infer<typeof CommandResultSchema>

export class CommandStepFailedError extends Error {
  readonly failure: StepFailure

  constructor(failure: StepFailure) {
    super(failure.detail)
    this.failure = failure
  }
}

/** Grace period between SIGTERM and SIGKILL on an idle-timeout trip.
 * Implementation constant, not a config field — see ticket 02. */
const KILL_GRACE_MS = 5_000

/** Docker CLI convention: `docker run` itself exits 125 when the container
 * never started (bad image, daemon unreachable, invalid invocation) — as
 * opposed to the exit code of the command running *inside* the container,
 * which passes through unchanged. Used to distinguish `'sandbox-error'`
 * from `'command-failed'` — see ticket 04/05, roadmap map. */
const DOCKER_CLI_ERROR_EXIT_CODE = 125

/** Ticket 04/05: fixed `/workspace` bind-mount + working dir convention,
 * `--network none` with no opt-out, `--rm` per-step lifecycle (no
 * persistent container). `--sig-proxy` defaults to `true`, so SIGTERM
 * sent to this `docker run` process forwards into the container —
 * idle-timeout's SIGTERM/SIGKILL sequence needs no docker-specific
 * handling beyond building the right argv. */
export function dockerRunArgs(step: CommandStep, cwd: string): string[] {
  const workdir = step.cwd ? `/workspace/${step.cwd}` : '/workspace'
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${cwd}:/workspace`,
    '-w',
    workdir,
    step.image!,
    'sh',
    '-c',
    step.run,
  ]
}

/** Splits a stream chunk into complete lines, invoking `onLine` for each,
 * and returns the trailing partial line to carry into the next chunk. */
function feedLines(carry: string, chunk: string, onLine: () => void): string {
  const combined = carry + chunk
  const lines = combined.split('\n')
  const remainder = lines.pop() ?? ''
  for (const _line of lines) onLine()
  return remainder
}

/** `extraEnv` is how a `map` item step reaches its own item — the minimal
 * per-item data channel a shell command has, the analog of an agent
 * step's `{{...}}` prompt templating. Merged over the inherited
 * environment, never replacing it.
 *
 * Streams via `spawn` rather than buffering with `spawnSync` so idle time
 * can be tracked from the last line of output, not total wall clock —
 * required for `idleTimeoutMs` enforcement. */
export function runCommandStep(
  step: CommandStep,
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  const capture = step.capture ?? ['stdout', 'stderr', 'exitCode']
  const failOn = step.failOn ?? 'exitCode'

  return new Promise((resolve, reject) => {
    const child =
      step.sandbox === 'docker'
        ? spawn('docker', dockerRunArgs(step, cwd), {
            ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
          })
        : spawn(step.run, {
            cwd: step.cwd ?? cwd,
            shell: true,
            ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
          })

    let stdout = ''
    let stderr = ''
    let stdoutCarry = ''
    let stderrCarry = ''
    let settled = false
    let timedOut = false
    let idleTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (killTimer) clearTimeout(killTimer)
    }

    const onLine = () => {
      if (step.idleTimeoutMs === undefined) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(onIdleTimeout, step.idleTimeoutMs)
    }

    function onIdleTimeout() {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }

    if (step.idleTimeoutMs !== undefined) idleTimer = setTimeout(onIdleTimeout, step.idleTimeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      stdoutCarry = feedLines(stdoutCarry, chunk, onLine)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      stderrCarry = feedLines(stderrCarry, chunk, onLine)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(
        step.sandbox === 'docker'
          ? new CommandStepFailedError({
              reason: 'sandbox-error',
              detail: `docker failed to start for command "${step.run}": ${err.message}`,
              recoverable: false,
            })
          : new CommandStepFailedError({
              reason: 'command-failed',
              detail: `command "${step.run}" failed to start: ${err.message}`,
              recoverable: false,
            }),
      )
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimers()

      if (timedOut) {
        reject(
          new CommandStepFailedError({
            reason: 'timeout',
            detail: `command "${step.run}" idle for longer than ${step.idleTimeoutMs}ms, killed`,
            recoverable: false,
          }),
        )
        return
      }

      const exitCode = code ?? (signal ? 1 : 0)

      const result: CommandResult = {}
      if (capture.includes('stdout')) result.stdout = stdout
      if (capture.includes('stderr')) result.stderr = stderr
      if (capture.includes('exitCode')) result.exitCode = exitCode

      if (step.sandbox === 'docker' && exitCode === DOCKER_CLI_ERROR_EXIT_CODE) {
        reject(
          new CommandStepFailedError({
            reason: 'sandbox-error',
            detail:
              `docker run exited ${DOCKER_CLI_ERROR_EXIT_CODE} for command "${step.run}" ` +
              `(image "${step.image}") — the container never started (bad image, daemon unreachable, ` +
              `invalid docker invocation), not the command inside it failing`,
            recoverable: false,
          }),
        )
        return
      }

      if (failOn === 'exitCode' && exitCode !== 0) {
        reject(
          new CommandStepFailedError({
            reason: 'command-failed',
            detail: `command "${step.run}" exited with code ${exitCode}`,
            recoverable: false,
          }),
        )
        return
      }

      resolve(result)
    })
  })
}
