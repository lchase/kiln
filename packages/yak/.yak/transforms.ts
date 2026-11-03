interface CommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export function summarizeChecks(inputs: Record<string, unknown>): unknown {
  const lint = inputs['lint-result'] as CommandResult
  const test = inputs['test-result'] as CommandResult
  return {
    lintPassed: lint.exitCode === 0,
    testPassed: test.exitCode === 0,
    ok: lint.exitCode === 0 && test.exitCode === 0,
  }
}

interface Plan {
  summary: string
  steps: string[]
}

export function summarizeAgentFixture(inputs: Record<string, unknown>): unknown {
  const plan = inputs['plan'] as Plan
  const check = inputs['check-result'] as CommandResult
  return {
    planSummary: plan.summary,
    stepCount: plan.steps.length,
    checked: check.exitCode === 0,
  }
}

interface Review {
  approved: boolean
  feedback: string
}

/** yak cookbook: review-and-revise loop. `review` is undefined on the
 * loop's first iteration (no prior round yet) — this is the one place
 * that's allowed to check for that; an agent step's `{{review.feedback}}`
 * template placeholder would throw instead. */
export function prepFeedback(inputs: Record<string, unknown>): unknown {
  const review = inputs['review'] as Review | undefined
  return review === undefined ? '(first attempt — no prior feedback yet)' : review.feedback
}

interface VitestJsonReport {
  numFailedTests: number
  numTotalTests: number
}

/** yak cookbook: review-and-revise loop. Parses `vitest run
 * --reporter=json`'s stdout into the numeric signal the loop's
 * `noProgress` budget reads (`numFailedTests` — 0 means `until` should
 * already be true via the review step's own judgment, since a truly
 * green suite is what "approved" is gated on). */
export function parseTestResult(inputs: Record<string, unknown>): unknown {
  const testRaw = inputs['testRaw'] as CommandResult
  const report = JSON.parse(testRaw.stdout ?? '{}') as Partial<VitestJsonReport>
  return {
    numFailedTests: report.numFailedTests ?? 0,
    numTotalTests: report.numTotalTests ?? 0,
  }
}

/** yak cookbook: fan-out-over-issues map. Static, deterministic batch —
 * the point of this pattern is the fan-out mechanics (concurrency,
 * per-item worktree isolation, auto-commit-before-fork), not sourcing
 * the batch itself. */
interface TodoExtract {
  todos: { task: string; priority: 'high' | 'medium' | 'low' }[]
}

/** yak cookbook: standalone transform. Pure reshaping of the extractor
 * agent's output into counts — no model call, no subprocess, just data
 * massaging. This is the entire point of a `transform` step existing as
 * its own kind rather than folding this into the agent's own schema or a
 * `command` step shelling out to node. */
export function summarizeTodos(inputs: Record<string, unknown>): unknown {
  const { todos } = inputs['extracted'] as TodoExtract
  const counts = { high: 0, medium: 0, low: 0 }
  for (const todo of todos) counts[todo.priority] += 1
  return { total: todos.length, byPriority: counts }
}

/** yak cookbook: map onItemFailure fail/retry. Static, deterministic —
 * item index 2 always fails its check (see the workflow's item `command`,
 * which branches on `$MAP_ITEM_INDEX`), the point is the failure-policy
 * mechanics, not sourcing the batch. */
export function batchChecks(): unknown {
  return [{ id: 'check-a' }, { id: 'check-b' }, { id: 'check-c' }]
}

export function batchIssues(): unknown {
  return [
    {
      id: 'capitalize',
      file: 'fixtures/batch-issues/src/capitalize.ts',
      test: 'fixtures/batch-issues/test/capitalize.test.ts',
    },
    {
      id: 'clamp',
      file: 'fixtures/batch-issues/src/clamp.ts',
      test: 'fixtures/batch-issues/test/clamp.test.ts',
    },
    {
      id: 'isPalindrome',
      file: 'fixtures/batch-issues/src/isPalindrome.ts',
      test: 'fixtures/batch-issues/test/isPalindrome.test.ts',
    },
  ]
}

/** yak cookbook: fan-out research + fan-in synthesis. A static, generic
 * topic list — three unrelated subjects, deliberately unrelated to this
 * repo itself, so the fixture demonstrates the fan-out/fan-in mechanics
 * without depending on anything outside its own workflow. */
export function researchTopics(): unknown {
  return [
    { topic: 'current adoption trends of the Rust programming language' },
    { topic: 'recent advances in solid-state batteries for electric vehicles' },
    { topic: 'the current state of quantum error correction research' },
  ]
}

interface ResearchFinding {
  topic: string
  summary: string
  sourceUrls: string[]
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** yak cookbook: fan-out research + fan-in synthesis. The fan-*in* half —
 * an ordinary `needs` on the map step's produced array, no special step
 * kind required — turning each item's findings into one self-contained
 * HTML report. A failed item lands as `null` in the array (`map`'s
 * default `onItemFailure: 'skip'`); this just leaves it out rather than
 * failing the whole report. */
export function renderResearchReport(inputs: Record<string, unknown>): unknown {
  const findings = inputs['findings'] as (ResearchFinding | null)[]

  const sections = findings
    .filter((f): f is ResearchFinding => f !== null)
    .map(
      (f) => `  <section>
    <h2>${escapeHtml(f.topic)}</h2>
    <p>${escapeHtml(f.summary)}</p>
    <ul>
${f.sourceUrls.map((u) => `      <li><a href="${escapeHtml(u)}">${escapeHtml(u)}</a></li>`).join('\n')}
    </ul>
  </section>`,
    )
    .join('\n')

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Research report</title></head>
<body>
<h1>Research report</h1>
${sections}
</body>
</html>
`
}
