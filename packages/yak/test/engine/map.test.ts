import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile } from '../../src/engine/run.js'

const WORKFLOWS_DIR = path.join(process.cwd(), 'test', 'workflows')

let dir: string
let cwd: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yak-map-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-map-cwd-'))
  await mkdir(path.join(cwd, '.yak'), { recursive: true })
  await writeFile(
    path.join(cwd, '.yak', 'transforms.ts'),
    [
      'export function threeItems() { return [0, 1, 2] }',
      'export function twoItems() { return [0, 1] }',
      'export function oneItem() { return [0] }',
    ].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

describe('map combinator: success', () => {
  it('runs every item and assembles the results into the produced array', async () => {
    const result = await executeWorkflowFile(path.join(WORKFLOWS_DIR, 'map-success.yaml'), {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('ok')

    const findings = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'findings.json'), 'utf8'),
    )
    expect(findings).toHaveLength(3)
    expect(findings.every((f: unknown) => f !== null)).toBe(true)

    for (const index of [0, 1, 2]) {
      const raw = await readFile(path.join(result.runDir, 'artifacts', `findings.${index}.json`), 'utf8')
      expect(JSON.parse(raw)).toBeTruthy()
    }

    const events = await readJournal(result.runDir)
    for (const index of [0, 1, 2]) {
      const started = events.find((e) => e.t === 'step.started' && e.stepId === `review[${index}]`)
      const completed = events.find((e) => e.t === 'step.completed' && e.stepId === `review[${index}]`)
      expect(started).toBeDefined()
      expect(completed).toBeDefined()
    }
  })
})

describe('map combinator: onItemFailure skip', () => {
  it('lands a failed item as null, map step still succeeds', async () => {
    const result = await executeWorkflowFile(path.join(WORKFLOWS_DIR, 'map-skip.yaml'), {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('ok')

    const findings = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'findings.json'), 'utf8'),
    )
    expect(findings).toEqual([expect.anything(), null])

    const events = await readJournal(result.runDir)
    const itemFailed = events.find((e) => e.t === 'step.failed' && e.stepId === 'review[1]')
    expect(itemFailed).toBeDefined()
  })
})

describe('map combinator: onItemFailure fail', () => {
  it('fails the whole map step when any item fails', async () => {
    const result = await executeWorkflowFile(path.join(WORKFLOWS_DIR, 'map-fail.yaml'), {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('failed')

    const events = await readJournal(result.runDir)
    const mapFailed = events.find((e) => e.t === 'step.failed' && e.stepId === 'review')
    expect(mapFailed).toBeDefined()

    // no assembled array is written when the map step itself fails
    await expect(readFile(path.join(result.runDir, 'artifacts', 'findings.json'), 'utf8')).rejects.toThrow()
  })
})

describe('map combinator: onItemFailure retry', () => {
  it('retries a failed item and keeps its result when a later attempt succeeds', async () => {
    const result = await executeWorkflowFile(path.join(WORKFLOWS_DIR, 'map-retry-succeeds.yaml'), {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('ok')

    const findings = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'findings.json'), 'utf8'),
    )
    expect(findings[0]).not.toBeNull()

    const events = await readJournal(result.runDir)
    const retried = events.filter((e) => e.t === 'map.item.retried' && e.mapStepId === 'review')
    expect(retried).toHaveLength(1)
  })

  it('falls back to skip (null) once retries are exhausted, map step still succeeds', async () => {
    const result = await executeWorkflowFile(path.join(WORKFLOWS_DIR, 'map-retry-exhausted.yaml'), {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('ok')

    const findings = JSON.parse(
      await readFile(path.join(result.runDir, 'artifacts', 'findings.json'), 'utf8'),
    )
    expect(findings).toEqual([null])

    const events = await readJournal(result.runDir)
    const retried = events.filter((e) => e.t === 'map.item.retried' && e.mapStepId === 'review')
    // RETRY_ATTEMPTS is fixed at 2 — 2 retries after the initial attempt, 3 total
    expect(retried).toHaveLength(2)

    const itemFailed = events.find((e) => e.t === 'step.failed' && e.stepId === 'review[0]')
    expect(itemFailed).toBeDefined()
  })
})
