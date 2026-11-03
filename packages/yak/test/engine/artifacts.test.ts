import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readArtifactRaw, writeArtifact } from '../../src/engine/artifacts.js'

let runDir: string

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'yak-artifacts-test-'))
})

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true })
})

describe('writeArtifact', () => {
  it('round-trips a value through write and read', async () => {
    await writeArtifact(runDir, 'out', { hello: 'world' }, z.object({ hello: z.string() }))
    const value = await readArtifactRaw(runDir, 'out')
    expect(value).toEqual({ hello: 'world' })
  })

  it('ticket 06: concurrent same-name writes never leave a torn/unparseable file for a concurrent reader', async () => {
    // Same shape as run-isolation.test.ts's 5-concurrent-runs cache test —
    // repeated overwrites of the same artifact path (a retried step
    // re-writing its own output) interleaved with reads. `writeArtifact`'s
    // atomic temp-file + rename means a reader always observes either a
    // fully-old or fully-new file, never a partial one.
    const schema = z.object({ n: z.number(), padding: z.string() })
    await writeArtifact(runDir, 'out', { n: -1, padding: 'x'.repeat(1000) }, schema)

    let readErrors = 0
    let reading = true

    const readLoop = (async () => {
      while (reading) {
        try {
          await readArtifactRaw(runDir, 'out')
        } catch {
          readErrors += 1
        }
      }
    })()

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeArtifact(runDir, 'out', { n: i, padding: 'x'.repeat(1000) }, schema),
      ),
    )
    reading = false
    await readLoop

    expect(readErrors).toBe(0)
  })
})
