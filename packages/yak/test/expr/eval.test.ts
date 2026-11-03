import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evalExpr } from '../../src/expr/eval.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-expr-eval-'))
  await mkdir(path.join(cwd, '.yak'), { recursive: true })
  await writeFile(
    path.join(cwd, '.yak', 'predicates.ts'),
    `export function isGreen(ctx) { return ctx['test-result'].exitCode === 0 }\nexport const notAFunction = 42\n`,
    'utf8',
  )
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('evalExpr', () => {
  it('evaluates a jexl string expression against the given context', async () => {
    const result = await evalExpr('r.exitCode == 0', { r: { exitCode: 0 } }, cwd)
    expect(result).toBe(true)
  })

  it('evaluates a jexl string expression that reads a nested field', async () => {
    const result = await evalExpr('r.failureCount', { r: { failureCount: 3 } }, cwd)
    expect(result).toBe(3)
  })

  it('resolves { fn } against .yak/predicates.ts', async () => {
    const result = await evalExpr({ fn: 'isGreen' }, { 'test-result': { exitCode: 0 } }, cwd)
    expect(result).toBe(true)
  })

  it('throws when { fn } names an export that is not a function', async () => {
    await expect(evalExpr({ fn: 'notAFunction' }, {}, cwd)).rejects.toThrow(/not found in \.yak\/predicates\.ts/)
  })

  it('throws when { fn } names an export that does not exist', async () => {
    await expect(evalExpr({ fn: 'nope' }, {}, cwd)).rejects.toThrow(/not found in \.yak\/predicates\.ts/)
  })
})
