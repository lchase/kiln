import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeDefinitionKey, computeSemanticKey, writeCacheEntry } from '../../src/engine/cache.js'
import { writeArtifact } from '../../src/engine/artifacts.js'
import { appendJournalEvent, readJournal } from '../../src/engine/journal.js'
import { resumeRun } from '../../src/engine/run.js'
import { loadWorkflowYaml } from '../../src/ir/load.js'
import { normalizeWorkflow } from '../../src/ir/normalize.js'
import type { CommandStep, Workflow } from '../../src/ir/types.js'
import { validateWorkflow } from '../../src/ir/validate.js'
import { CommandResultSchema, runCommandStep } from '../../src/steps/command.js'

const CI_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'ci.yaml')

/** Builds a run dir frozen mid-flight: `install` and `lint` completed (with
 * cache entries), `test` has `step.started` and nothing after — the same
 * shape a SIGINT during `test` would leave behind (spec §14 acceptance #3). */
async function setUpInterruptedRun(dir: string): Promise<{
  runsDir: string
  runId: string
  runDir: string
  workflow: Workflow
}> {
  const raw = await loadWorkflowYaml(CI_WORKFLOW)
  const workflow = normalizeWorkflow(raw)
  await validateWorkflow(workflow)

  const runsDir = path.join(dir, '.runs')
  const cacheDir = path.join(dir, '.yak', 'cache')
  const runId = 'interrupted-run'
  const runDir = path.join(runsDir, runId)

  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8')
  await appendJournalEvent(runDir, runId, {
    t: 'run.started',
    runId,
    workflow: workflow.name,
    inputHash: 'irrelevant',
    adapter: 'mock',
    isolation: 'none',
  })

  const install = workflow.steps.find((s) => s.id === 'install') as CommandStep
  const lint = workflow.steps.find((s) => s.id === 'lint') as CommandStep
  const test = workflow.steps.find((s) => s.id === 'test') as CommandStep

  const installResult = await runCommandStep(install, process.cwd())
  const installArtifact = await writeArtifact(runDir, 'install-result', installResult, CommandResultSchema)
  const installSemanticKey = computeSemanticKey(install, {})
  const installDefinitionKey = computeDefinitionKey(install)
  await appendJournalEvent(runDir, runId, {
    t: 'step.started',
    stepId: 'install',
    semanticKey: installSemanticKey,
    definitionKey: installDefinitionKey,
  })
  await appendJournalEvent(runDir, runId, {
    t: 'artifact.written',
    name: installArtifact.name,
    hash: installArtifact.hash,
    bytes: installArtifact.bytes,
  })
  await appendJournalEvent(runDir, runId, {
    t: 'step.completed',
    stepId: 'install',
    artifact: installArtifact.name,
    artifactHash: installArtifact.hash,
    cached: false,
  })
  await writeCacheEntry(cacheDir, {
    semanticKey: installSemanticKey,
    definitionKey: installDefinitionKey,
    artifactName: installArtifact.name,
    artifactHash: installArtifact.hash,
    artifact: installResult,
  })

  const lintResult = await runCommandStep(lint, process.cwd())
  const lintArtifact = await writeArtifact(runDir, 'lint-result', lintResult, CommandResultSchema)
  const lintSemanticKey = computeSemanticKey(lint, { 'install-result': installArtifact.hash })
  const lintDefinitionKey = computeDefinitionKey(lint)
  await appendJournalEvent(runDir, runId, {
    t: 'step.started',
    stepId: 'lint',
    semanticKey: lintSemanticKey,
    definitionKey: lintDefinitionKey,
  })
  await appendJournalEvent(runDir, runId, {
    t: 'artifact.written',
    name: lintArtifact.name,
    hash: lintArtifact.hash,
    bytes: lintArtifact.bytes,
  })
  await appendJournalEvent(runDir, runId, {
    t: 'step.completed',
    stepId: 'lint',
    artifact: lintArtifact.name,
    artifactHash: lintArtifact.hash,
    cached: false,
  })
  await writeCacheEntry(cacheDir, {
    semanticKey: lintSemanticKey,
    definitionKey: lintDefinitionKey,
    artifactName: lintArtifact.name,
    artifactHash: lintArtifact.hash,
    artifact: lintResult,
  })

  // `test` was dispatched but SIGINT landed before it finished: started, no
  // completed/failed, no artifact, no cache entry.
  await appendJournalEvent(runDir, runId, {
    t: 'step.started',
    stepId: 'test',
    semanticKey: computeSemanticKey(test, { 'install-result': installArtifact.hash }),
    definitionKey: computeDefinitionKey(test),
  })
  await appendJournalEvent(runDir, runId, { t: 'run.suspended', reason: 'gate' })

  return { runsDir, runId, runDir, workflow }
}

describe('resume — acceptance behavior #3', () => {
  it('reuses install and lint, re-runs only test and summarize', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yak-'))
    const { runsDir, runId, runDir } = await setUpInterruptedRun(dir)

    const result = await resumeRun(runId, { runsDir })

    expect(result.status).toBe('ok')

    const events = await readJournal(runDir)
    const completedIds = events
      .filter((e) => e.t === 'step.completed')
      .map((e) => (e as { stepId: string }).stepId)
    // install/lint's step.completed events are the ones written during
    // setup (not re-journaled by resume); test and summarize are new.
    expect(completedIds).toEqual(['install', 'lint', 'test', 'summarize'])

    const cachedFlags = new Map(
      events
        .filter((e) => e.t === 'step.completed')
        .map((e) => [(e as { stepId: string }).stepId, (e as { cached: boolean }).cached]),
    )
    expect(cachedFlags.get('test')).toBe(false)
    expect(cachedFlags.get('summarize')).toBe(false)

    const testArtifact = JSON.parse(await readFile(path.join(runDir, 'artifacts', 'test-result.json'), 'utf8'))
    expect(testArtifact.stdout.trim()).toBe('tested')

    const summary = JSON.parse(await readFile(path.join(runDir, 'artifacts', 'summary.json'), 'utf8'))
    expect(summary).toEqual({ lintPassed: true, testPassed: true, ok: true })

    // install/lint artifacts untouched by resume
    const lintArtifact = JSON.parse(await readFile(path.join(runDir, 'artifacts', 'lint-result.json'), 'utf8'))
    expect(lintArtifact.stdout.trim()).toBe('linted')

    // yak#24: resume records its own pid so `yak cancel` can find it.
    const resumed = events.find((e) => e.t === 'run.resumed')
    expect(resumed?.t === 'run.resumed' && resumed.pid).toBe(process.pid)
  })
})
