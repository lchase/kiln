import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAdapter } from '../../src/adapters/mock.js'

let fixturesDir: string

beforeEach(async () => {
  fixturesDir = await mkdtemp(path.join(tmpdir(), 'yak-mock-fixtures-'))
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(fixturesDir, { recursive: true, force: true })
})

async function writeFixture(workflow: string, stepId: string, entries: unknown[]): Promise<void> {
  const dir = path.join(fixturesDir, workflow)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${stepId}.json`), JSON.stringify(entries), 'utf8')
}

const baseReq = { prompt: 'p', tools: [], cwd: '.', signal: new AbortController().signal }

describe('MockAdapter', () => {
  it('returns the single fixture entry with defaulted fields', async () => {
    await writeFixture('wf', 'plan', [{ output: { ok: true } }])
    const adapter = new MockAdapter(fixturesDir, 'wf', 'plan')

    const res = await adapter.run(baseReq)

    expect(res.output).toEqual({ ok: true })
    expect(res.stopReason).toBe('complete')
    expect(res.tokens).toEqual({ input: 0, output: 0 })
    expect(res.filesChanged).toEqual([])
    expect(res.sessionId).toBe('mock:plan:0')
  })

  it('consumes entries in call order, then repeats the last one', async () => {
    await writeFixture('wf', 'code', [{ output: 'invalid' }, { output: 'valid' }])
    const adapter = new MockAdapter(fixturesDir, 'wf', 'code')

    const first = await adapter.run(baseReq)
    const second = await adapter.run(baseReq)
    const third = await adapter.run(baseReq)

    expect(first.output).toBe('invalid')
    expect(second.output).toBe('valid')
    expect(third.output).toBe('valid')
    expect([first.sessionId, second.sessionId, third.sessionId]).toEqual([
      'mock:code:0',
      'mock:code:1',
      'mock:code:2',
    ])
  })

  it('ticket 08: iteration selects the starting fixture entry for a looped step', async () => {
    await writeFixture('wf', 'test', [{ output: 'iter1-fail' }, { output: 'iter2-fail' }, { output: 'iter3-pass' }])

    const iter3 = new MockAdapter(fixturesDir, 'wf', 'test', 3)
    expect((await iter3.run(baseReq)).output).toBe('iter3-pass')

    const iter1 = new MockAdapter(fixturesDir, 'wf', 'test', 1)
    expect((await iter1.run(baseReq)).output).toBe('iter1-fail')
  })

  it('ticket 08: within one iteration, further calls (schema repair) still advance past the iteration start', async () => {
    await writeFixture('wf', 'test', [{ output: 'a' }, { output: 'b' }, { output: 'c' }])
    const adapter = new MockAdapter(fixturesDir, 'wf', 'test', 2)

    const first = await adapter.run(baseReq)
    const second = await adapter.run(baseReq)

    expect(first.output).toBe('b')
    expect(second.output).toBe('c')
  })

  it('ignores sessionId and tools on the request', async () => {
    await writeFixture('wf', 'step', [{ output: 'a' }, { output: 'b' }])
    const adapter = new MockAdapter(fixturesDir, 'wf', 'step')

    await adapter.run({ ...baseReq, sessionId: 'whatever', tools: ['Read', 'Write'] })
    const second = await adapter.run(baseReq)

    expect(second.output).toBe('b')
  })

  it('honors fixture-specified tokens, filesChanged, and stopReason', async () => {
    await writeFixture('wf', 'edit', [
      { output: 'x', tokens: { input: 10, output: 5 }, filesChanged: ['a.ts'], stopReason: 'max_turns' },
    ])
    const adapter = new MockAdapter(fixturesDir, 'wf', 'edit')

    const res = await adapter.run(baseReq)

    expect(res.tokens).toEqual({ input: 10, output: 5 })
    expect(res.filesChanged).toEqual(['a.ts'])
    expect(res.stopReason).toBe('max_turns')
  })
})
