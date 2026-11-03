import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandStep } from '../../src/ir/types.js'
import { CommandStepFailedError, dockerRunArgs, runCommandStep } from '../../src/steps/command.js'

function step(overrides: Partial<CommandStep>): CommandStep {
  return { id: 'test-step', kind: 'command', run: 'true', ...overrides }
}

/** Ticket 05: a fake `docker` binary placed first on `PATH` (via
 * `runCommandStep`'s `extraEnv`, which is merged over `process.env`), so
 * sandbox-error tests exercise the real spawn/close path without
 * requiring a real Docker install (or a running daemon) on the test
 * machine. */
async function withFakeDocker(exitCode: number, run: (extraEnv: Record<string, string>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yak-fake-docker-'))
  const binPath = path.join(dir, 'docker')
  await writeFile(binPath, `#!/bin/sh\nexit ${exitCode}\n`)
  await chmod(binPath, 0o755)
  try {
    await run({ PATH: `${dir}:${process.env.PATH}` })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('runCommandStep', () => {
  it('captures stdout, stderr, exitCode from a streamed process', async () => {
    const result = await runCommandStep(
      step({ run: 'printf "line1\\nline2\\n"; printf "err1\\n" 1>&2' }),
      process.cwd(),
    )
    expect(result.stdout).toBe('line1\nline2\n')
    expect(result.stderr).toBe('err1\n')
    expect(result.exitCode).toBe(0)
  })

  it('fails with command-failed on nonzero exit when failOn is exitCode', async () => {
    await expect(runCommandStep(step({ run: 'exit 3' }), process.cwd())).rejects.toMatchObject({
      failure: { reason: 'command-failed', recoverable: false },
    })
  })

  it('does not fail on nonzero exit when failOn is never', async () => {
    const result = await runCommandStep(step({ run: 'exit 3', failOn: 'never' }), process.cwd())
    expect(result.exitCode).toBe(3)
  })

  it('is not affected by idleTimeoutMs when the command produces output within the window', async () => {
    const result = await runCommandStep(step({ run: 'echo hi', idleTimeoutMs: 2_000 }), process.cwd())
    expect(result.stdout).toBe('hi\n')
  })

  it(
    'kills a silent process and fails with reason timeout once idleTimeoutMs elapses',
    async () => {
      // `sleep` has no SIGTERM handler, so the default action (terminate) fires
      // immediately — this resolves well inside the 5s SIGTERM→SIGKILL grace
      // period, so the test doesn't have to wait it out. Explicit timeout above
      // vitest's 5000ms default gives slower/loaded CI runners headroom.
      const failing = runCommandStep(step({ run: 'sleep 5', idleTimeoutMs: 50 }), process.cwd())
      await expect(failing).rejects.toBeInstanceOf(CommandStepFailedError)
      await failing.catch((err: CommandStepFailedError) => {
        expect(err.failure.reason).toBe('timeout')
        expect(err.failure.recoverable).toBe(false)
      })
    },
    10000,
  )

  describe('sandbox: docker', () => {
    it('builds the expected docker run argv — fixed /workspace mount, --network none, --rm', () => {
      const args = dockerRunArgs(
        step({ run: 'npm test', sandbox: 'docker', image: 'node:22' }),
        '/host/worktree',
      )
      expect(args).toEqual([
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        '/host/worktree:/workspace',
        '-w',
        '/workspace',
        'node:22',
        'sh',
        '-c',
        'npm test',
      ])
    })

    it('nests the working dir under /workspace when step.cwd is set', () => {
      const args = dockerRunArgs(
        step({ run: 'npm test', sandbox: 'docker', image: 'node:22', cwd: 'packages/app' }),
        '/host/worktree',
      )
      expect(args).toContain('-w')
      expect(args[args.indexOf('-w') + 1]).toBe('/workspace/packages/app')
      // mount source is always the worktree root, unaffected by step.cwd
      expect(args).toContain('/host/worktree:/workspace')
    })

    it('fails with sandbox-error, not command-failed, when the container never starts (docker CLI exit 125)', async () => {
      await withFakeDocker(125, async (extraEnv) => {
        await expect(
          runCommandStep(step({ run: 'echo hi', sandbox: 'docker', image: 'does-not-exist' }), process.cwd(), extraEnv),
        ).rejects.toMatchObject({
          failure: { reason: 'sandbox-error', recoverable: false },
        })
      })
    })

    it('still reports command-failed for a normal nonzero exit from inside the container', async () => {
      await withFakeDocker(3, async (extraEnv) => {
        await expect(
          runCommandStep(step({ run: 'exit 3', sandbox: 'docker', image: 'node:22' }), process.cwd(), extraEnv),
        ).rejects.toMatchObject({
          failure: { reason: 'command-failed', recoverable: false },
        })
      })
    })
  })
})
