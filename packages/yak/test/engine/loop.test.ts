import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile, readRunWorkflow, resumeRun } from '../../src/engine/run.js'
import { loopStatusFromJournal } from '../../src/engine/status.js'
import { normalizeWorkflow } from '../../src/ir/normalize.js'
import type { JournalEnvelope, LoopStep, Step } from '../../src/ir/types.js'
import { validateWorkflow } from '../../src/ir/validate.js'

const LOOP_SUCCESS_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'loop-success.yaml')
const LOOP_BUDGET_EXHAUSTED_WORKFLOW = path.join(
  process.cwd(),
  'test',
  'workflows',
  'loop-budget-exhausted.yaml',
)
const LOOP_NO_PROGRESS_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'loop-no-progress.yaml')
const LOOP_PRODUCES_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'loop-produces.yaml')

let dir: string
let cwd: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yak-loop-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-loop-cwd-'))
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

describe('loop combinator: success', () => {
  it('runs the body repeatedly until `until` is satisfied, then stops', async () => {
    const result = await executeWorkflowFile(LOOP_SUCCESS_WORKFLOW, { runsDir: path.join(dir, '.runs'), cwd })

    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const iterations = events.filter((e) => e.t === 'loop.iteration')
    // the counter trips exit 0 on the 3rd `test` run, and `until` is checked
    // after each full iteration — so iterations 1 and 2 fail `until` and get
    // a loop.iteration event; iteration 3 satisfies `until` and returns
    // before ever journaling a 3rd loop.iteration event.
    expect(iterations.map((e) => (e as { n: number }).n)).toEqual([1, 2])

    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted.map((e) => (e as { iteration?: number }).iteration)).toEqual([1, 2, 3])
  })

  it('writes a per-iteration artifact file for each body step run', async () => {
    const result = await executeWorkflowFile(LOOP_SUCCESS_WORKFLOW, { runsDir: path.join(dir, '.runs'), cwd })
    expect(result.status).toBe('ok')

    for (const iteration of [1, 2, 3]) {
      const raw = await readFile(path.join(result.runDir, 'artifacts', `testresult.${iteration}.json`), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.exitCode).toBe(iteration === 3 ? 0 : 1)
    }
  })
})

describe('loop combinator: budget exhaustion', () => {
  it('suspends after maxIterations, never satisfying until, default onExhausted', async () => {
    const result = await executeWorkflowFile(LOOP_BUDGET_EXHAUSTED_WORKFLOW, {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('suspended')

    const events = await readJournal(result.runDir)
    const suspended = events.find((e) => e.t === 'run.suspended')
    expect(suspended).toMatchObject({
      t: 'run.suspended',
      reason: 'exhausted',
      loopStepId: 'fix-until-green',
      iteration: 3,
      tripped: 'maxIterations',
    })

    // ran exactly maxIterations (3) full iterations, per ticket 03: checks
    // happen at iteration boundaries only, not mid-iteration.
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(3)

    const finished = events.find((e) => e.t === 'run.finished')
    expect(finished).toMatchObject({ status: 'suspended' })
  })
})

describe('loop combinator: no-progress exhaustion', () => {
  it('suspends after `rounds` consecutive non-improving signal readings, before maxIterations', async () => {
    const result = await executeWorkflowFile(LOOP_NO_PROGRESS_WORKFLOW, { runsDir: path.join(dir, '.runs'), cwd })

    expect(result.status).toBe('suspended')

    const events = await readJournal(result.runDir)
    const suspended = events.find((e) => e.t === 'run.suspended')
    expect(suspended).toMatchObject({
      t: 'run.suspended',
      reason: 'exhausted',
      loopStepId: 'fix-until-green',
      iteration: 2,
      tripped: 'noProgress',
    })

    // tripped by noProgress (rounds: 2) well before maxIterations (5) would
    // ever have been reached.
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(2)
  })
})

describe('M4 tickets 02/06/08: resuming a loop-exhausted run', () => {
  it('leaves the run suspended, untouched, when no answer file exists yet', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_BUDGET_EXHAUSTED_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    await expect(resumeRun(result.runId, { runsDir, cwd })).rejects.toThrow(
      /fix-until-green.*no answer file/s,
    )

    // confirm it's a no-op — no further iterations were run, no journal change
    const events = await readJournal(result.runDir)
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(3)
    expect(events.some((e) => e.t === 'gate.answered')).toBe(false)
  })

  it('fails the loop step with budget-exhausted on an "abort" answer', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_BUDGET_EXHAUSTED_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'fix-until-green.answer.json'),
      JSON.stringify({ action: 'abort' }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir, cwd })
    expect(resumed.status).toBe('failed')

    const events = await readJournal(result.runDir)
    const failure = events.find((e) => e.t === 'step.failed' && e.stepId === 'fix-until-green')
    expect(failure).toMatchObject({ failure: { reason: 'budget-exhausted' } })
  })

  it('resumes from the tripped iteration on a "continue" answer with addIterations', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const runsDir = path.join(dir, '.runs')

    // A variant that succeeds only on the 4th `test` run — out of reach of
    // the original maxIterations: 3, reachable only via addIterations.
    // The counter file's path is embedded directly (no shell env
    // indirection) so the command is portable across /bin/sh variants.
    const counterFile = path.join(cwd, 'counter')
    const workflowPath = path.join(cwd, 'loop-continue.yaml')
    await writeFile(
      workflowPath,
      `name: loop-continue
version: "1"
steps:
  - id: fix-until-green
    loop:
      until: "testresult.exitCode == 0"
      budget:
        maxIterations: 3
      body:
        - id: implement
          command: { run: "true" }
          produces: code
        - id: test
          needs: [code]
          command: { run: "c=$(cat ${counterFile} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${counterFile}; test $c -ge 4 && exit 0 || exit 1", capture: [exitCode], failOn: never }
          produces: testresult
`,
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'fix-until-green.answer.json'),
      JSON.stringify({ action: 'continue', addIterations: 2 }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir, cwd })
    expect(resumed.status).toBe('ok')

    const events = await readJournal(resumed.runDir)
    // 3 iterations before suspend + 1 more after resume = 4 `test` starts
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(4)
    expect(testStarted.map((e) => (e as { iteration?: number }).iteration)).toEqual([1, 2, 3, 4])
  })
})

describe('ticket 09: yak status detail for a loop', () => {
  it('reports iteration, budget, and the latest noProgress signal while suspended', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_NO_PROGRESS_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    const workflow = await readRunWorkflow(result.runDir)
    const loopStep = workflow.steps.find((s) => s.id === 'fix-until-green') as LoopStep
    const events = await readJournal(result.runDir)

    const detail = loopStatusFromJournal(loopStep, events)

    expect(detail).toMatchObject({
      stepId: 'fix-until-green',
      state: 'suspended',
      iteration: 2,
      maxIterations: 5,
      noProgressSignal: 1,
    })
  })

  it('reports state completed with the final iteration once until is satisfied', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_SUCCESS_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('ok')

    const workflow = await readRunWorkflow(result.runDir)
    const loopStep = workflow.steps.find((s) => s.id === 'fix-until-green') as LoopStep
    const events = await readJournal(result.runDir)

    const detail = loopStatusFromJournal(loopStep, events)

    expect(detail).toMatchObject({ stepId: 'fix-until-green', state: 'completed', iteration: 3 })
  })
})

describe('yak#35: a loop step with `produces` writes its own artifact', () => {
  it('writes the final until-context object and orders a downstream `needs` after the loop', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_PRODUCES_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('ok')

    // the loop's artifact is the last iteration's body artifacts, keyed by name
    const raw = await readFile(path.join(result.runDir, 'artifacts', 'deliverable.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.testresult.exitCode).toBe(0)
    expect(parsed.code.exitCode).toBe(0)

    const events = await readJournal(result.runDir)

    // step.completed for the loop carries the artifact
    const loopDone = events.find((e) => e.t === 'step.completed' && e.stepId === 'fix-until-green')
    expect(loopDone).toMatchObject({ artifact: 'deliverable' })
    expect((loopDone as { artifactHash?: string }).artifactHash).toBeTruthy()

    // artifact.written was journaled for the loop's produces
    expect(events.some((e) => e.t === 'artifact.written' && e.name === 'deliverable')).toBe(true)

    // the downstream step that `needs: [deliverable]` starts only after the loop completed
    const loopDoneIdx = events.findIndex((e) => e.t === 'step.completed' && e.stepId === 'fix-until-green')
    const approveStartIdx = events.findIndex((e) => e.t === 'step.started' && e.stepId === 'approve')
    expect(approveStartIdx).toBeGreaterThan(loopDoneIdx)
  })

  it('resume trusts the loop artifact from the journal and re-runs nothing', async () => {
    const runsDir = path.join(dir, '.runs')
    const first = await executeWorkflowFile(LOOP_PRODUCES_WORKFLOW, { runsDir, cwd })
    expect(first.status).toBe('ok')

    const again = await resumeRun(first.runId, { runsDir, cwd })
    expect(again.status).toBe('ok')

    // resume replayed the journal, trusted every completed step (loop
    // included) and launched nothing new — no second run of the body.
    const events = await readJournal(first.runDir)
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(3)
  })
})

describe('loop body parallelism', () => {
  const runsDir = () => path.join(dir, '.runs')

  async function writeTransforms(): Promise<void> {
    await mkdir(path.join(cwd, '.yak'), { recursive: true })
    await writeFile(
      path.join(cwd, '.yak', 'transforms.ts'),
      [
        'export function joinReviews(inputs) {',
        '  return { ok: true, security: inputs.security, ux: inputs.ux, ui: inputs.ui }',
        '}',
        'export function recordPrior(inputs) {',
        '  const ticket = inputs.ticket',
        "  const stdout = ticket && typeof ticket.stdout === 'string' ? ticket.stdout.trim() : null",
        '  return { hadPrior: ticket !== undefined, stdout }',
        '}',
        'export function recordAll(inputs) {',
        '  return {',
        '    hadPrior: inputs.security !== undefined,',
        '    security: inputs.security === undefined ? null : inputs.security,',
        '    ux: inputs.ux === undefined ? null : inputs.ux,',
        '    code: inputs.code === undefined ? null : inputs.code,',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    )
  }

  async function writeFixture(workflow: string, stepId: string, entries: unknown[]): Promise<void> {
    const fixtureDir = path.join(cwd, 'test', 'fixtures', workflow)
    await mkdir(fixtureDir, { recursive: true })
    await writeFile(path.join(fixtureDir, `${stepId}.json`), JSON.stringify(entries), 'utf8')
  }

  async function writeWorkflow(fileName: string, lines: string[]): Promise<string> {
    const workflowPath = path.join(cwd, fileName)
    await writeFile(workflowPath, lines.join('\n'), 'utf8')
    return workflowPath
  }

  function eventIndex(events: JournalEnvelope[], t: JournalEnvelope['t'], stepId: string): number {
    return events.findIndex((event) => event.t === t && 'stepId' in event && event.stepId === stepId)
  }

  function startedSteps(events: JournalEnvelope[], stepId: string) {
    return events.filter(
      (event): event is Extract<JournalEnvelope, { t: 'step.started' }> =>
        event.t === 'step.started' && event.stepId === stepId,
    )
  }

  function completedSteps(events: JournalEnvelope[], stepId: string) {
    return events.filter(
      (event): event is Extract<JournalEnvelope, { t: 'step.completed' }> =>
        event.t === 'step.completed' && event.stepId === stepId,
    )
  }

  async function readIter(runDir: string, name: string, iteration: number): Promise<unknown> {
    return JSON.parse(await readFile(path.join(runDir, 'artifacts', `${name}.${iteration}.json`), 'utf8'))
  }

  it('starts three siblings with concurrency 3 before any of them finishes', async () => {
    const workflowPath = await writeWorkflow('overlap.yaml', [
      'name: loop-overlap',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      concurrency: 3',
      '      until: "true"',
      '      budget:',
      '        maxIterations: 1',
      '      body:',
      '        - id: security',
      '          command: { run: "sleep 0.3 && echo sec", capture: [stdout] }',
      '          produces: security',
      '        - id: ux',
      '          command: { run: "sleep 0.3 && echo ux", capture: [stdout] }',
      '          produces: ux',
      '        - id: ui',
      '          command: { run: "sleep 0.3 && echo ui", capture: [stdout] }',
      '          produces: ui',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const starts = ['security', 'ux', 'ui'].map((id) => eventIndex(events, 'step.started', id))
    const dones = ['security', 'ux', 'ui'].map((id) => eventIndex(events, 'step.completed', id))
    const firstDone = Math.min(...dones)
    for (const start of starts) {
      expect(start).toBeGreaterThanOrEqual(0)
      expect(start).toBeLessThan(firstDone)
    }
  })

  it('runs a step that needs all three last and gives it this round\'s values', async () => {
    await writeTransforms()
    await writeFixture('loop-parallel-join', 'security', [{ output: { findings: 'sec' } }])
    await writeFixture('loop-parallel-join', 'ux', [{ output: { findings: 'ux' } }])
    await writeFixture('loop-parallel-join', 'ui', [{ output: { findings: 'ui' } }])
    const workflowPath = await writeWorkflow('join.yaml', [
      'name: loop-parallel-join',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      concurrency: 3',
      '      until: "joined.ok == true"',
      '      budget:',
      '        maxIterations: 1',
      '      body:',
      '        - id: security',
      '          agent:',
      '            prompt: { inline: "review security" }',
      '          produces: security',
      '        - id: ux',
      '          agent:',
      '            prompt: { inline: "review ux" }',
      '          produces: ux',
      '        - id: ui',
      '          agent:',
      '            prompt: { inline: "review ui" }',
      '          produces: ui',
      '        - id: join',
      '          needs: [security, ux, ui]',
      '          transform: { fn: joinReviews }',
      '          produces: joined',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const joinStart = eventIndex(events, 'step.started', 'join')
    for (const id of ['security', 'ux', 'ui']) {
      expect(joinStart).toBeGreaterThan(eventIndex(events, 'step.completed', id))
    }

    expect(await readIter(result.runDir, 'joined', 1)).toEqual({
      ok: true,
      security: { findings: 'sec' },
      ux: { findings: 'ux' },
      ui: { findings: 'ui' },
    })
  })

  it('keeps declared order when concurrency is left at the default', async () => {
    const workflowPath = await writeWorkflow('serial.yaml', [
      'name: loop-serial',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      until: "true"',
      '      budget:',
      '        maxIterations: 1',
      '      body:',
      '        - id: security',
      '          command: { run: "echo sec" }',
      '          produces: security',
      '        - id: ux',
      '          command: { run: "echo ux" }',
      '          produces: ux',
      '        - id: ui',
      '          command: { run: "echo ui" }',
      '          produces: ui',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const order = ['security', 'ux', 'ui'].flatMap((id) => [
      eventIndex(events, 'step.started', id),
      eventIndex(events, 'step.completed', id),
    ])
    const sorted = [...order].sort((a, b) => a - b)
    expect(order).toEqual(sorted)
    expect(new Set(order).size).toBe(order.length)
  })

  it('runs [a, b needs a, c] in declared order at the default concurrency', async () => {
    const workflowPath = await writeWorkflow('declared.yaml', [
      'name: loop-declared',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      until: "true"',
      '      budget:',
      '        maxIterations: 1',
      '      body:',
      '        - id: a',
      '          command: { run: "echo a" }',
      '          produces: a',
      '        - id: b',
      '          needs: [a]',
      '          command: { run: "echo b" }',
      '          produces: b',
      '        - id: c',
      '          command: { run: "echo c" }',
      '          produces: c',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const order = ['a', 'b', 'c'].flatMap((id) => [
      eventIndex(events, 'step.started', id),
      eventIndex(events, 'step.completed', id),
    ])
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(new Set(order).size).toBe(order.length)
  })

  it('at concurrency 2 lets c overtake b while b is still waiting on a', async () => {
    const workflowPath = await writeWorkflow('overtake.yaml', [
      'name: loop-overtake',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      concurrency: 2',
      '      until: "true"',
      '      budget:',
      '        maxIterations: 1',
      '      body:',
      '        - id: a',
      '          command: { run: "sleep 0.3 && echo a" }',
      '          produces: a',
      '        - id: b',
      '          needs: [a]',
      '          command: { run: "echo b" }',
      '          produces: b',
      '        - id: c',
      '          command: { run: "echo c" }',
      '          produces: c',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const aDone = eventIndex(events, 'step.completed', 'a')
    const bStart = eventIndex(events, 'step.started', 'b')
    const cStart = eventIndex(events, 'step.started', 'c')
    const cDone = eventIndex(events, 'step.completed', 'c')
    // c does not depend on a or b, so it runs in the first wave with a
    // and finishes while a is still sleeping. b waits for a, so it starts
    // only after c has already finished. a and c start together; their
    // step.started writes are not ordered against each other.
    expect(cStart).toBeGreaterThanOrEqual(0)
    expect(cDone).toBeLessThan(aDone)
    expect(bStart).toBeGreaterThan(aDone)
    expect(cStart).toBeLessThan(bStart)
  })

  it('resolves a backward input to the previous round, undefined on round 1', async () => {
    await writeTransforms()
    await writeFixture('loop-backward', 'narrator', [{ output: { ok: true } }])
    const producerRun =
      'c=$(cat counter 2>/dev/null || echo 0); c=$((c+1)); echo $c > counter; echo round$c'
    const workflowPath = await writeWorkflow('backward.yaml', [
      'name: loop-backward',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      concurrency: 3',
      '      until: "seen.hadPrior == true"',
      '      budget:',
      '        maxIterations: 4',
      '      body:',
      '        - id: blocker',
      '          command: { run: "sleep 0.25 && echo go", capture: [stdout] }',
      '          produces: gate',
      '        - id: lookback',
      '          needs: [gate, ticket]',
      '          transform: { fn: recordPrior }',
      '          produces: seen',
      '        - id: narrator',
      '          needs: [ticket]',
      '          agent:',
      '            prompt:',
      '              inline: \'prior {{ ticket || "none yet" }}\'',
      '          produces: narration',
      '        - id: producer',
      `          command: { run: "${producerRun}", capture: [stdout] }`,
      '          produces: ticket',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('ok')

    expect(await readIter(result.runDir, 'seen', 1)).toEqual({ hadPrior: false, stdout: null })
    expect(await readIter(result.runDir, 'seen', 2)).toEqual({ hadPrior: true, stdout: 'round1' })
    const round2 = (await readIter(result.runDir, 'ticket', 2)) as { stdout: string }
    expect(round2.stdout.trim()).toBe('round2')
  })

  it('records exactly one loop failure and starts nothing new after a sibling fails', async () => {
    const workflowPath = await writeWorkflow('fail.yaml', [
      'name: loop-fail-sibling',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      concurrency: 2',
      '      until: "true"',
      '      budget:',
      '        maxIterations: 2',
      '      body:',
      '        - id: slow-ok',
      '          command: { run: "sleep 0.4 && echo ok", capture: [stdout] }',
      '          produces: slow',
      '        - id: fail-fast',
      '          command: { run: "exit 1" }',
      '        - id: never',
      '          command: { run: "echo should-not-run" }',
      '          produces: never',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('failed')

    const events = await readJournal(result.runDir)
    const loopFailures = events.filter((event) => event.t === 'step.failed' && event.stepId === 'revise')
    expect(loopFailures).toHaveLength(1)
    expect(events.filter((event) => event.t === 'step.failed' && event.stepId === 'fail-fast')).toHaveLength(1)
    expect(events.some((event) => event.t === 'step.started' && event.stepId === 'never')).toBe(false)
    expect(events.some((event) => event.t === 'step.started' && event.stepId === 'slow-ok')).toBe(true)
    expect(eventIndex(events, 'step.completed', 'slow-ok')).toBeGreaterThanOrEqual(0)
    expect(eventIndex(events, 'step.completed', 'slow-ok')).toBeLessThan(eventIndex(events, 'step.failed', 'revise'))
  })

  it('resumes a budget stop with a parallel body and keeps each round on its own cache key', async () => {
    await writeTransforms()
    for (const [stepId, findings] of [
      ['security', 'sec'],
      ['ux', 'ux'],
      ['code', 'code'],
    ] as const) {
      await writeFixture('loop-parallel-resume', stepId, [
        { output: { findings: `${findings}-1` } },
        { output: { findings: `${findings}-2` } },
      ])
    }
    const workflowPath = await writeWorkflow('resume.yaml', [
      'name: loop-parallel-resume',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      concurrency: 4',
      '      until: "seen.hadPrior == true"',
      '      budget:',
      '        maxIterations: 1',
      '      body:',
      '        - id: blocker',
      '          command: { run: "sleep 0.25 && echo go", capture: [stdout] }',
      '          produces: gate',
      '        - id: lookback',
      '          needs: [gate, security, ux, code]',
      '          transform: { fn: recordAll }',
      '          produces: seen',
      '        - id: security',
      '          agent:',
      '            prompt: { inline: "review security" }',
      '          produces: security',
      '        - id: ux',
      '          agent:',
      '            prompt: { inline: "review ux" }',
      '          produces: ux',
      '        - id: code',
      '          agent:',
      '            prompt: { inline: "review code" }',
      '          produces: code',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('suspended')
    expect(await readIter(result.runDir, 'seen', 1)).toEqual({
      hadPrior: false,
      security: null,
      ux: null,
      code: null,
    })

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'revise.answer.json'),
      JSON.stringify({ action: 'continue', addIterations: 1 }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir: runsDir(), cwd })
    expect(resumed.status).toBe('ok')
    expect(await readIter(result.runDir, 'seen', 2)).toEqual({
      hadPrior: true,
      security: { findings: 'sec-1' },
      ux: { findings: 'ux-1' },
      code: { findings: 'code-1' },
    })
    expect(await readIter(result.runDir, 'security', 2)).toEqual({ findings: 'sec-2' })

    const events = await readJournal(result.runDir)
    expect(events.some((event) => event.t === 'gate.answered' && event.stepId === 'revise')).toBe(true)
    for (const id of ['security', 'ux', 'code']) {
      const starts = startedSteps(events, id)
      expect(starts.map((event) => event.iteration)).toEqual([1, 2])
      expect(starts[0]?.semanticKey).not.toBe(starts[1]?.semanticKey)
      const round2 = completedSteps(events, id).find((event) => event.iteration === 2)
      expect(round2).toMatchObject({ cached: false })
    }
  })

  it('reuses per-round cache entries on a second run and does not reuse them across rounds', async () => {
    await writeFixture('loop-round-cache', 'reviewer', [{ output: { note: 'same' } }])
    const workflowPath = await writeWorkflow('cache.yaml', [
      'name: loop-round-cache',
      'version: "1"',
      'steps:',
      '  - id: revise',
      '    loop:',
      '      until: "false"',
      '      onExhausted: continue',
      '      budget:',
      '        maxIterations: 2',
      '      body:',
      '        - id: reviewer',
      '          agent:',
      '            prompt: { inline: "review" }',
      '          produces: notes',
    ])

    const first = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(first.status).toBe('ok')
    const firstEvents = await readJournal(first.runDir)
    const firstCompleted = completedSteps(firstEvents, 'reviewer')
    expect(firstCompleted.map((event) => event.iteration)).toEqual([1, 2])
    expect(firstCompleted.every((event) => event.cached === false)).toBe(true)
    const firstStarted = startedSteps(firstEvents, 'reviewer')
    expect(firstStarted[0]?.semanticKey).not.toBe(firstStarted[1]?.semanticKey)

    const second = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(second.status).toBe('ok')
    const secondEvents = await readJournal(second.runDir)
    const secondCompleted = completedSteps(secondEvents, 'reviewer')
    expect(secondCompleted.map((event) => ({ iteration: event.iteration, cached: event.cached }))).toEqual([
      { iteration: 1, cached: true },
      { iteration: 2, cached: true },
    ])
    const secondStarted = startedSteps(secondEvents, 'reviewer')
    expect(secondStarted.map((event) => event.semanticKey)).toEqual(firstStarted.map((event) => event.semanticKey))
  })

  it('resumes after a gate and then runs a parallel body', async () => {
    await writeTransforms()
    await writeFixture('loop-after-gate', 'security', [{ output: { findings: 'sec' } }])
    await writeFixture('loop-after-gate', 'ux', [{ output: { findings: 'ux' } }])
    await writeFixture('loop-after-gate', 'ui', [{ output: { findings: 'ui' } }])
    const workflowPath = await writeWorkflow('after-gate.yaml', [
      'name: loop-after-gate',
      'version: "1"',
      'steps:',
      '  - id: approve',
      '    gate:',
      '      schema:',
      '        inline:',
      '          type: object',
      '          properties:',
      '            decision: { type: string, enum: [approve, reject] }',
      '            notes: { type: string }',
      '          required: [decision]',
      '      render: { inline: "Approve this change?" }',
      '    produces: decision',
      '  - id: revise',
      '    needs: [decision]',
      '    loop:',
      '      concurrency: 3',
      '      until: "joined.ok == true"',
      '      budget:',
      '        maxIterations: 2',
      '      body:',
      '        - id: security',
      '          agent:',
      '            prompt: { inline: "review security" }',
      '          produces: security',
      '        - id: ux',
      '          agent:',
      '            prompt: { inline: "review ux" }',
      '          produces: ux',
      '        - id: ui',
      '          agent:',
      '            prompt: { inline: "review ui" }',
      '          produces: ui',
      '        - id: join',
      '          needs: [security, ux, ui]',
      '          transform: { fn: joinReviews }',
      '          produces: joined',
    ])

    const result = await executeWorkflowFile(workflowPath, { runsDir: runsDir(), cwd, adapter: 'mock' })
    expect(result.status).toBe('suspended')
    const before = await readJournal(result.runDir)
    expect(before.some((event) => event.t === 'step.started' && event.stepId === 'security')).toBe(false)

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'approve.answer.json'),
      JSON.stringify({ decision: 'approve' }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir: runsDir(), cwd })
    expect(resumed.status).toBe('ok')
    expect(await readIter(result.runDir, 'joined', 1)).toEqual({
      ok: true,
      security: { findings: 'sec' },
      ux: { findings: 'ux' },
      ui: { findings: 'ui' },
    })

    const events = await readJournal(result.runDir)
    const joinStart = eventIndex(events, 'step.started', 'join')
    for (const id of ['security', 'ux', 'ui']) {
      expect(joinStart).toBeGreaterThan(eventIndex(events, 'step.completed', id))
    }
  })
})

describe('loop concurrency parse and validate', () => {
  function workflow(steps: Step[]) {
    return { name: 'w', version: '1', steps }
  }

  function rawLoop(concurrency?: number) {
    return {
      name: 'w',
      version: '1',
      steps: [
        {
          id: 'revise',
          loop: {
            ...(concurrency !== undefined ? { concurrency } : {}),
            until: 'true',
            budget: { maxIterations: 1 },
            body: [{ id: 'a', command: { run: 'true' } }],
          },
        },
      ],
    }
  }

  it('defaults concurrency to 1 and accepts a positive integer', () => {
    const omitted = normalizeWorkflow(rawLoop())
    expect((omitted.steps[0] as LoopStep).concurrency).toBe(1)

    const set = normalizeWorkflow(rawLoop(4))
    expect((set.steps[0] as LoopStep).concurrency).toBe(4)
  })

  it('rejects a non-positive or non-integer concurrency at parse time', () => {
    expect(() => normalizeWorkflow(rawLoop(0))).toThrow(/concurrency/)
    expect(() => normalizeWorkflow(rawLoop(-2))).toThrow(/concurrency/)
    expect(() => normalizeWorkflow(rawLoop(1.5))).toThrow(/concurrency/)
  })

  it('rejects map, loop, and gate inside a body at load time', async () => {
    const cases: { kind: 'map' | 'loop' | 'gate'; body: Step }[] = [
      {
        kind: 'map',
        body: { id: 'fan', kind: 'map', over: 'items', step: { id: 'one', kind: 'command', run: 'true' } },
      },
      {
        kind: 'loop',
        body: {
          id: 'inner',
          kind: 'loop',
          until: 'true',
          budget: { maxIterations: 1 },
          body: [{ id: 'a', kind: 'command', run: 'true' }],
        },
      },
      {
        kind: 'gate',
        body: {
          id: 'approve',
          kind: 'gate',
          schema: { inline: { type: 'object' } },
          render: { inline: 'go?' },
        },
      },
    ]

    for (const { kind, body } of cases) {
      const step: LoopStep = {
        id: 'revise',
        kind: 'loop',
        until: 'true',
        budget: { maxIterations: 1 },
        body: [body],
      }
      await expect(validateWorkflow(workflow([step]))).rejects.toThrow(
        `step "${body.id}": kind "${kind}" not supported inside a loop body in M3`,
      )
    }
  })

  it('accepts {{ name || "default" }} when the leading identifier is a declared need', async () => {
    const raw = normalizeWorkflow({
      name: 'w',
      version: '1',
      steps: [
        {
          id: 'revise',
          loop: {
            until: 'true',
            budget: { maxIterations: 1 },
            body: [
              {
                id: 'security',
                needs: ['security'],
                produces: 'security',
                agent: { prompt: { inline: '{{ security || "none yet" }}' } },
              },
            ],
          },
        },
      ],
    })
    await expect(validateWorkflow(raw)).resolves.toBeUndefined()
  })

  it('rejects an or-default whose other operand is an undeclared identifier', async () => {
    const raw = normalizeWorkflow({
      name: 'w',
      version: '1',
      steps: [
        {
          id: 'revise',
          loop: {
            until: 'true',
            budget: { maxIterations: 1 },
            body: [
              {
                id: 'security',
                needs: ['security'],
                produces: 'security',
                agent: { prompt: { inline: '{{ security || secrity }}' } },
              },
            ],
          },
        },
      ],
    })
    await expect(validateWorkflow(raw)).rejects.toThrow(/prompt references "\{\{secrity\}\}"/)
  })

  it('still rejects an or-default whose leading identifier is not a declared need', async () => {
    const raw = normalizeWorkflow({
      name: 'w',
      version: '1',
      steps: [
        {
          id: 'revise',
          loop: {
            until: 'true',
            budget: { maxIterations: 1 },
            body: [
              {
                id: 'security',
                needs: ['security'],
                produces: 'security',
                agent: { prompt: { inline: '{{ missing || "x" }}' } },
              },
            ],
          },
        },
      ],
    })
    await expect(validateWorkflow(raw)).rejects.toThrow(/prompt references "\{\{missing\}\}"/)
  })

  it('warns when parallel body siblings declare a write-capable tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const step: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 4,
      until: 'true',
      budget: { maxIterations: 1 },
      body: [
        { id: 'security', kind: 'agent', prompt: { inline: 'review' }, tools: ['Read', 'Edit'], produces: 'security' },
        { id: 'ux', kind: 'agent', prompt: { inline: 'review' }, tools: ['Read'], produces: 'ux' },
      ],
    }
    await expect(validateWorkflow(workflow([step]))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/write-capable tool "Edit"/))
    warn.mockRestore()
  })

  it('warns for Bash, and stays quiet when siblings cannot overlap or concurrency is 1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parallelBash: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 2,
      until: 'true',
      budget: { maxIterations: 1 },
      body: [
        { id: 'security', kind: 'agent', prompt: { inline: 'review' }, tools: ['Bash'], produces: 'security' },
        { id: 'ux', kind: 'agent', prompt: { inline: 'review' }, tools: ['Read'], produces: 'ux' },
      ],
    }
    await validateWorkflow(workflow([parallelBash]))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/write-capable tool "Bash"/))
    warn.mockClear()

    const ordered: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 4,
      until: 'true',
      budget: { maxIterations: 1 },
      body: [
        { id: 'implement', kind: 'agent', prompt: { inline: 'build' }, tools: ['Edit'], produces: 'code' },
        {
          id: 'review',
          kind: 'agent',
          needs: ['code'],
          prompt: { inline: 'review' },
          tools: ['Edit'],
          produces: 'review',
        },
      ],
    }
    await validateWorkflow(workflow([ordered]))

    const readOnly: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 4,
      until: 'true',
      budget: { maxIterations: 1 },
      body: [
        { id: 'security', kind: 'agent', prompt: { inline: 'review' }, tools: ['Read', 'Grep'], produces: 'security' },
        { id: 'ux', kind: 'agent', prompt: { inline: 'review' }, tools: ['Read'], produces: 'ux' },
      ],
    }
    await validateWorkflow(workflow([readOnly]))

    const serial: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 1,
      until: 'true',
      budget: { maxIterations: 1 },
      body: [
        { id: 'security', kind: 'agent', prompt: { inline: 'review' }, tools: ['Edit'], produces: 'security' },
        { id: 'ux', kind: 'agent', prompt: { inline: 'review' }, tools: ['Write'], produces: 'ux' },
      ],
    }
    await validateWorkflow(workflow([serial]))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns when a parallel command step shares the cwd', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = [
      { id: 'build', kind: 'command' as const, run: 'npm test', produces: 'build' },
      { id: 'lint', kind: 'command' as const, run: 'npm run lint', produces: 'lint' },
    ]
    const parallel: LoopStep = {
      id: 'revise',
      kind: 'loop',
      concurrency: 2,
      until: 'true',
      budget: { maxIterations: 1 },
      body,
    }
    await validateWorkflow(workflow([parallel]))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"build" is a command step/))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"lint" is a command step/))
    warn.mockClear()

    const serial: LoopStep = { ...parallel, concurrency: 1 }
    await validateWorkflow(workflow([serial]))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
