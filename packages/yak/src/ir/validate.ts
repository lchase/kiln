import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { extractTemplateRoots } from '../expr/template.js'
import { agentInputNames, buildProducerMap, dependenciesOf, earlierProducerIds, flattenSteps } from './graph.js'
import { describeSchemaSpec, resolveSchemaSpec, type SchemaSpec } from './schema-resolve.js'
import { INPUT_ARTIFACT } from './types.js'
import type { ArtifactName, Expr, GateStep, LoopStep, RunIsolation, Step, StepId, Workflow } from './types.js'

export class WorkflowValidationError extends Error {}

const KNOWN_KINDS = new Set(['agent', 'command', 'transform', 'gate', 'map', 'loop'])

/**
 * M2 ticket 01 ("tools mapping to SDK allowedTools"): the confirmed,
 * yak-usable subset of the Claude Agent SDK's public tool names. The SDK's
 * shipped `.d.ts` defines more names than this — internal Claude
 * Code/product surface, not stable third-party API — so only this list is
 * accepted here rather than deferring to the SDK's own (undocumented)
 * unknown-tool-name behavior.
 *
 * `AskUserQuestion` is deliberately excluded (ticket 10's addendum):
 * interactive tools always fall through to a `canUseTool` callback
 * regardless of `permissionMode`, including `bypassPermissions`, and yak
 * has no such callback wired (agent steps have no channel to ask a human,
 * spec §3.6) — declaring it would stall the step at runtime instead of
 * failing at load time.
 */
const KNOWN_AGENT_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Skill',
])

export async function validateWorkflow(
  workflow: Workflow,
  cwd: string = process.cwd(),
  runIsolation: RunIsolation = 'none',
): Promise<void> {
  const flatSteps = flattenSteps(workflow.steps)
  checkKnownKinds(flatSteps)
  checkLoopBodyKinds(workflow.steps)
  checkDuplicateIds(flatSteps)
  const producerOf = buildProducerMap(workflow.steps)
  checkReservedArtifactNames(flatSteps)
  checkNeedsSatisfied(workflow.steps, producerOf)
  checkNoCycles(workflow.steps, producerOf)
  checkExprArtifactIdentifiers(workflow.steps, producerOf)
  checkExitCodeReads(workflow.steps, producerOf)
  checkAgentToolNames(flatSteps)
  await checkAgentSchemaKeys(flatSteps, cwd)
  await checkAgentPromptPlaceholders(flatSteps, cwd)
  checkSessionChainDepth(flatSteps)
  checkMapIsolation(workflow.steps, runIsolation)
  checkLoopParallelWriters(workflow.steps)
  await checkGateSchemaKeys(flatSteps, cwd)
  await checkGateRenderPlaceholders(flatSteps, cwd)
  checkSandboxImage(flatSteps)
  checkAllowedDomains(flatSteps)
  await checkDockerAvailable(flatSteps)
}

/** Ticket 04/05 (roadmap map): `sandbox: 'docker'` has no yak-shipped
 * default image — yak doesn't know a step's toolchain, so a missing
 * `image` is a load-time error rather than a cryptic run-time failure. */
function checkSandboxImage(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind !== 'command' || step.sandbox !== 'docker') continue
    if (!step.image) {
      throw new WorkflowValidationError(
        `step "${step.id}": sandbox: 'docker' requires an "image" field — yak has no default image`,
      )
    }
  }
}

/** Hostnames only — same shape Kiln emits. A leading dot, scheme, port,
 * path, or wildcard would widen squid's `dstdomain` match or break the
 * generated ACL. Single-label names (`localhost`) are rejected: the proxy
 * allowlist is for external hosts. */
const ALLOWLIST_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

function checkAllowedDomains(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind !== 'agent' || step.allowedDomains === undefined) continue
    if (step.allowedDomains.length === 0) {
      throw new WorkflowValidationError(`step "${step.id}": allowedDomains must list at least one hostname`)
    }
    for (const domain of step.allowedDomains) {
      if (!ALLOWLIST_HOSTNAME.test(domain)) {
        throw new WorkflowValidationError(`step "${step.id}": allowedDomains entry "${domain}" is not a hostname`)
      }
    }
  }
}

const execFileAsync = promisify(execFile)

/** Ticket 04/05 (`command`) / 07/08 (`agent`): fail the whole workflow
 * before any run starts if `docker` isn't on PATH but some step needs it —
 * same "fail where the workflow author can see it" reasoning as every
 * other check in this file, rather than discovering it mid-run on the
 * first sandboxed step. Unlike `command`, an `agent` step's `image` is
 * optional (ticket 07: yak ships a default), so only the `docker`-on-PATH
 * check applies to it — no `checkSandboxImage`-style required-field check. */
async function checkDockerAvailable(steps: Step[]): Promise<void> {
  const needsDocker = (step: Step) =>
    (step.kind === 'command' || step.kind === 'agent') && step.sandbox === 'docker'
  if (!steps.some(needsDocker)) return
  try {
    await execFileAsync('docker', ['--version'])
  } catch {
    throw new WorkflowValidationError(
      `workflow uses sandbox: 'docker' on at least one step, but the "docker" binary was not found on PATH`,
    )
  }
}

/** Ticket 07 (M3) / t03 (M5): `isolation: 'none'` means concurrent items
 * literally share one process cwd, so `concurrency > 1` with a write-capable
 * item step (`Edit`, `Write`, or `Bash` — `Bash` counts as write-capable
 * since the engine can't tell read-only shell usage from a mutating one) is
 * a structural race the loader can catch, not a caller footgun to document
 * and hope is avoided. `isolation: 'worktree'` sidesteps that race (each
 * item gets its own worktree) but only makes sense forked from the run's
 * own branch (map.ts decision), which only exists when the run itself is
 * `--isolation worktree` — requesting item-level worktrees under a
 * `none`-isolated run is a load-time error, not a silent fallback. */
const WRITE_CAPABLE_TOOLS = new Set(['Edit', 'Write', 'Bash'])

function checkMapIsolation(steps: Step[], runIsolation: RunIsolation): void {
  for (const step of steps) {
    if (step.kind === 'loop') checkMapIsolation(step.body, runIsolation)
    if (step.kind !== 'map') continue

    if (step.isolation === 'worktree') {
      if (runIsolation !== 'worktree') {
        throw new WorkflowValidationError(
          `step "${step.id}": isolation: 'worktree' requires the run itself to use --isolation worktree ` +
            `(there's no run branch to fork an item worktree from otherwise) — use isolation: 'none' or ` +
            `omit isolation, or run with --isolation worktree`,
        )
      }
    } else {
      const concurrency = step.concurrency ?? 4
      if (concurrency > 1 && step.step.kind === 'agent') {
        const writeTool = (step.step.tools ?? []).find((tool) => WRITE_CAPABLE_TOOLS.has(tool))
        if (writeTool) {
          throw new WorkflowValidationError(
            `step "${step.id}": isolation: 'none' with concurrency ${concurrency} and item step ` +
              `"${step.step.id}" declaring write-capable tool "${writeTool}" — concurrent items would ` +
              `share one cwd and race; use concurrency: 1 or drop the write-capable tool`,
          )
        }
      }
    }

    checkMapIsolation([step.step], runIsolation)
  }
}

/** `map` / `loop` / `gate` inside a loop body used to surface only once the
 * body step actually ran (`loop.ts`'s `runBodyStepKind`). Validation already
 * walks into bodies, so reject them at load time with that same message. */
const UNSUPPORTED_LOOP_BODY_KINDS = new Set<Step['kind']>(['map', 'loop', 'gate'])

function checkLoopBodyKinds(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind === 'map') {
      checkLoopBodyKinds([step.step])
      continue
    }
    if (step.kind !== 'loop') continue
    for (const bodyStep of step.body) {
      if (UNSUPPORTED_LOOP_BODY_KINDS.has(bodyStep.kind)) {
        throw new WorkflowValidationError(
          `step "${bodyStep.id}": kind "${bodyStep.kind}" not supported inside a loop body in M3`,
        )
      }
    }
    checkLoopBodyKinds(step.body)
  }
}

/** Parallel body steps share the loop's cwd, the same race `checkMapIsolation`
 * rejects for `isolation: 'none'`. A loop opts into that race with
 * `concurrency > 1`, so warn (the default of 1 never overlaps) when two body
 * steps can actually run in the same round and one of them can write that
 * cwd: an agent tool of `Edit` / `Write` / `Bash`, or any command step
 * (commands share the cwd and may write files there). A later step that
 * waits on an earlier one — directly or through other this-round producers
 * — does not overlap it. A non-positive `concurrency` is rejected by the
 * raw-loop schema at parse time, not here. */
function checkLoopParallelWriters(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind === 'loop') {
      warnParallelWriteCapableBody(step)
      checkLoopParallelWriters(step.body)
    } else if (step.kind === 'map') {
      checkLoopParallelWriters([step.step])
    }
  }
}

function writeCapableTool(step: Step): string | undefined {
  if (step.kind !== 'agent') return undefined
  return (step.tools ?? []).find((tool) => WRITE_CAPABLE_TOOLS.has(tool))
}

/** True when `step` waits, this round, on `targetId` — directly, or through
 * other earlier body steps. Edges only point at earlier positions, so this
 * walk terminates. */
function waitsOn(
  step: Step,
  targetId: StepId,
  stepsById: Map<StepId, Step>,
  producerOf: Map<ArtifactName, StepId>,
  order: Map<StepId, number>,
): boolean {
  const seen = new Set<StepId>()
  const startPos = order.get(step.id)
  if (startPos === undefined) return false
  const stack = earlierProducerIds(step, startPos, producerOf, order)
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    if (id === targetId) return true
    seen.add(id)
    const pred = stepsById.get(id)
    const predPos = order.get(id)
    if (!pred || predPos === undefined) continue
    stack.push(...earlierProducerIds(pred, predPos, producerOf, order))
  }
  return false
}

function warnParallelWriteCapableBody(loop: LoopStep): void {
  const concurrency = loop.concurrency ?? 1
  if (concurrency <= 1 || loop.body.length < 2) return

  const order = new Map(loop.body.map((bodyStep, index) => [bodyStep.id, index]))
  const stepsById = new Map(loop.body.map((bodyStep) => [bodyStep.id, bodyStep]))
  const producerOf = buildProducerMap(loop.body)
  const warned = new Set<StepId>()

  for (let i = 0; i < loop.body.length; i++) {
    for (let j = i + 1; j < loop.body.length; j++) {
      const earlier = loop.body[i]
      const later = loop.body[j]
      if (!earlier || !later) continue
      if (waitsOn(later, earlier.id, stepsById, producerOf, order)) continue
      for (const bodyStep of [earlier, later]) {
        if (warned.has(bodyStep.id)) continue
        const tool = writeCapableTool(bodyStep)
        const command = bodyStep.kind === 'command'
        if (!tool && !command) continue
        const why = command ? 'is a command step' : `declares write-capable tool "${tool}"`
        const fix = command ? 'use concurrency: 1' : 'use concurrency: 1 or drop the write-capable tool'
        console.warn(
          `step "${loop.id}": concurrency ${concurrency} runs body steps "${earlier.id}" and "${later.id}" in parallel, ` +
            `and "${bodyStep.id}" ${why} — concurrent body steps share one cwd and may race; ${fix}`,
        )
        warned.add(bodyStep.id)
      }
    }
  }
}

function checkAgentToolNames(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind !== 'agent') continue
    for (const tool of step.tools ?? []) {
      if (!KNOWN_AGENT_TOOLS.has(tool)) {
        throw new WorkflowValidationError(
          `step "${step.id}": unknown or unsupported tool "${tool}" — must be one of ` +
            `${[...KNOWN_AGENT_TOOLS].join(', ')}`,
        )
      }
    }
  }
}

function checkKnownKinds(steps: Step[]): void {
  for (const step of steps) {
    if (!KNOWN_KINDS.has(step.kind)) {
      throw new WorkflowValidationError(`step "${step.id}": unknown step kind "${step.kind}"`)
    }
  }
}

function checkDuplicateIds(steps: Step[]): void {
  const seen = new Set<StepId>()
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new WorkflowValidationError(`duplicate step id "${step.id}"`)
    }
    seen.add(step.id)
  }
}

/** Ticket 01: a body step's `needs` resolves first against its own loop's
 * local producer map (other body steps), falling through to the outer
 * scope's producer map — an artifact produced only inside a loop is never
 * visible outside it, so the outer scope passed to a nested loop is never
 * widened with that loop's own locals. */
/** `input` (spec §13) is the one artifact the engine supplies itself, from
 * `yak run --input` — no step produces it, so a step may `needs` it without
 * a producer, and no step may claim it as its own `produces`. */
function checkReservedArtifactNames(steps: Step[]): void {
  for (const step of steps) {
    if (step.produces === INPUT_ARTIFACT) {
      throw new WorkflowValidationError(
        `step "${step.id}": "${INPUT_ARTIFACT}" is a reserved artifact name (the run input) — a step cannot produce it`,
      )
    }
  }
}

function checkNeedsSatisfied(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      if (need === INPUT_ARTIFACT) continue
      if (!producerOf.has(need)) {
        throw new WorkflowValidationError(
          `step "${step.id}": needs artifact "${need}" but no step produces it`,
        )
      }
    }
    if (step.kind === 'loop') {
      const localProducerOf = new Map([...producerOf, ...buildProducerMap(step.body)])
      checkNeedsSatisfied(step.body, localProducerOf)
    }
    if (step.kind === 'map') {
      checkNeedsSatisfied([step.step], producerOf)
    }
  }
}

function checkNoCycles(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  const stepsById = new Map(steps.map((s) => [s.id, s]))
  const state = new Map<StepId, 'visiting' | 'done'>()

  function visit(step: Step, path: StepId[]): void {
    const mark = state.get(step.id)
    if (mark === 'done') return
    if (mark === 'visiting') {
      const cycle = [...path, step.id].join(' -> ')
      throw new WorkflowValidationError(`cycle detected: ${cycle}`)
    }
    state.set(step.id, 'visiting')
    for (const depId of dependenciesOf(step, producerOf)) {
      const dep = stepsById.get(depId)
      if (dep) visit(dep, [...path, step.id])
    }
    state.set(step.id, 'done')
  }

  for (const step of steps) visit(step, [])
}

const JEXL_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** yak#36: `skipIf` / loop `until` / `noProgress.signal` are jexl expressions.
 * jexl has no notion of a hyphenated identifier — it parses `verify-result`
 * as `verify - result` (subtraction), silently, against `undefined` operands.
 * A step whose expression textually references a declared artifact whose name
 * isn't a valid jexl identifier is therefore always a logic bug: the
 * expression can never see that artifact (the gate never skips, the loop
 * never trips). Reject it at load time with the rename it needs, rather than
 * letting the step misbehave with no error at runtime. */
function checkExprArtifactIdentifiers(
  steps: Step[],
  producerOf: Map<ArtifactName, StepId>,
): void {
  for (const step of steps) {
    if (step.skipIf !== undefined) checkExprRefs(step.id, 'skipIf', step.skipIf, producerOf)
    if (step.kind === 'loop') {
      const localProducerOf = new Map([...producerOf, ...buildProducerMap(step.body)])
      checkExprRefs(step.id, 'until', step.until, localProducerOf)
      if (step.budget.noProgress) {
        checkExprRefs(step.id, 'noProgress.signal', step.budget.noProgress.signal, localProducerOf)
      }
      checkExprArtifactIdentifiers(step.body, localProducerOf)
    }
    if (step.kind === 'map') checkExprArtifactIdentifiers([step.step], producerOf)
  }
}

function checkExprRefs(
  stepId: StepId,
  field: string,
  expr: Expr,
  producerOf: Map<ArtifactName, StepId>,
): void {
  if (typeof expr !== 'string') return
  for (const name of producerOf.keys()) {
    if (JEXL_IDENTIFIER.test(name)) continue
    const bounded = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`)
    if (!bounded.test(expr)) continue
    throw new WorkflowValidationError(
      `step "${stepId}": ${field} references artifact "${name}", but "${name}" is not a valid jexl ` +
        `identifier — jexl reads it as an expression ("a-b" parses as "a minus b"), not a name, so the ` +
        `artifact is invisible to ${field}. Rename it to an identifier (e.g. "${toIdentifier(name)}").`,
    )
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toIdentifier(name: string): string {
  const camel = name.replace(/[^A-Za-z0-9]+([A-Za-z0-9])?/g, (_, c?: string) =>
    c ? c.toUpperCase() : '',
  )
  return JEXL_IDENTIFIER.test(camel) ? camel : `a${camel}`
}

/**
 * Spec §9 #6: reading `<artifact>.exitCode` downstream of a command step that
 * still has `failOn: 'exitCode'` is dead code — that step can never survive a
 * non-zero exit, so the read is always `0`. Reject it at load time.
 */
function checkExitCodeReads(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  const stepsById = new Map(steps.map((s) => [s.id, s]))

  for (const step of steps) {
    for (const expr of exprsIn(step)) {
      for (const artifactName of exitCodeReferences(expr)) {
        const producerId = producerOf.get(artifactName)
        if (!producerId) continue
        const producer = stepsById.get(producerId)
        if (producer?.kind === 'command' && (producer.failOn ?? 'exitCode') === 'exitCode') {
          throw new WorkflowValidationError(
            `step "${step.id}" reads "${artifactName}.exitCode", but step "${producer.id}" ` +
              `has failOn: 'exitCode' — that step can never produce a non-zero exitCode`,
          )
        }
      }
    }
  }
}

function exprsIn(step: Step): Expr[] {
  const exprs: Expr[] = []
  if (step.skipIf) exprs.push(step.skipIf)
  if (step.kind === 'loop') {
    exprs.push(step.until)
    if (step.budget.noProgress) exprs.push(step.budget.noProgress.signal)
    for (const inner of step.body) exprs.push(...exprsIn(inner))
  }
  if (step.kind === 'map') exprs.push(...exprsIn(step.step))
  return exprs
}

function exitCodeReferences(expr: Expr): ArtifactName[] {
  if (typeof expr !== 'string') return []
  const matches = [...expr.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\.exitCode\b/g)]
  return matches.map((m) => m[1]!)
}

/** §13 `AgentStep.schema` is "a key in .yak/schemas.ts", or (roadmap map
 * ticket 09 / M1 ticket 08) an inline JSON Schema. Reject an unresolvable
 * named ref or a malformed inline document at load time rather than
 * failing the first time the step runs — `resolveSchemaSpec` throws for
 * either case (missing export, or ajv rejecting the schema against its own
 * meta-schema during `compile`). */
async function checkAgentSchemaKeys(steps: Step[], cwd: string): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'agent' || !step.schema) continue
    await checkSchemaSpecResolves(step.id, step.schema, cwd)
  }
}

async function checkSchemaSpecResolves(stepId: StepId, spec: SchemaSpec, cwd: string): Promise<void> {
  try {
    await resolveSchemaSpec(spec, cwd)
  } catch (err) {
    throw new WorkflowValidationError(
      `step "${stepId}": could not resolve schema ${describeSchemaSpec(spec)}: ${(err as Error).message}`,
    )
  }
}

/** §13 `GateStep.schema` is a key in `.yak/schemas.ts` or an inline JSON
 * Schema, same resolver convention as `AgentStep.schema`
 * (`checkAgentSchemaKeys`). M4 ticket 05: a gate with `skipIf` additionally
 * requires every field on that schema to default — `schema.parseDefaults()`
 * must succeed, since the skip path parses `{}` through the schema to
 * synthesize the artifact. */
async function checkGateSchemaKeys(steps: Step[], cwd: string): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'gate') continue

    await checkSchemaSpecResolves(step.id, step.schema, cwd)
    const schema = await resolveSchemaSpec(step.schema, cwd)

    if (step.skipIf !== undefined) {
      const defaulted = schema.parseDefaults()
      if (!defaulted.success) {
        throw new WorkflowValidationError(
          `step "${step.id}": has skipIf but schema ${describeSchemaSpec(step.schema)} doesn't default ` +
            `every field (parsing {} failed: ${defaulted.errorSummary}) — every field needs a default so ` +
            `a skip can synthesize the answer artifact`,
        )
      }
    }

    checkFlatAnswerSchema(step, schema)
  }
}

/** M4 ticket 04: `--interactive` only knows how to render a flat answer
 * schema — top-level object, each property a scalar (string/number/
 * boolean) or enum, optionally wrapped in `.optional()`/`.default()` (Zod
 * branch) or absent from `required` (inline JSON Schema branch). Rejected
 * here, at load time, rather than discovered mid-prompt at runtime — same
 * "fail where the workflow author can see it" reasoning as every other
 * schema check in this file. */
function checkFlatAnswerSchema(step: GateStep, schema: { isFlatAnswerObject(): { ok: boolean; reason?: string } }): void {
  const check = schema.isFlatAnswerObject()
  if (!check.ok) {
    throw new WorkflowValidationError(
      `step "${step.id}": schema ${describeSchemaSpec(step.schema)} ${check.reason} — --interactive can ` +
        `only render string/number/boolean/enum properties`,
    )
  }
}

/** A gate's `render` template placeholders must resolve against its `needs`,
 * same rule as an agent step's prompt (`checkAgentPromptPlaceholders`). */
async function checkGateRenderPlaceholders(steps: Step[], cwd: string): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'gate') continue

    const text =
      'file' in step.render
        ? await readFile(path.resolve(cwd, step.render.file), 'utf8')
        : step.render.inline

    const allowed = new Set<ArtifactName>(step.needs ?? [])

    for (const root of extractTemplateRoots(text)) {
      if (!allowed.has(root)) {
        throw new WorkflowValidationError(
          `step "${step.id}": render references "{{${root}}}" but "${root}" is not in needs`,
        )
      }
    }
  }
}

/** A prompt placeholder's root must be a declared input — `needs` or
 * `context.inherit` — otherwise the dependency graph is lying about what
 * the step actually reads. */
async function checkAgentPromptPlaceholders(steps: Step[], cwd: string): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'agent') continue

    const text =
      'file' in step.prompt
        ? await readFile(path.resolve(cwd, step.prompt.file), 'utf8')
        : step.prompt.inline

    const allowed = new Set(agentInputNames(step))

    for (const root of extractTemplateRoots(text)) {
      if (!allowed.has(root)) {
        throw new WorkflowValidationError(
          `step "${step.id}": prompt references "{{${root}}}" but "${root}" is not in ` +
            `needs or context.inherit`,
        )
      }
    }
  }
}

/** §3.4: the engine "warns when a chain [of context.session resumes]
 * exceeds 3" — a warning, not a load-time failure, since a long chain is
 * discouraged but not invalid. */
function checkSessionChainDepth(steps: Step[]): void {
  const stepsById = new Map(steps.map((s) => [s.id, s]))

  function sessionParentOf(step: Step): StepId | undefined {
    if (step.kind !== 'agent') return undefined
    if (typeof step.context !== 'object' || !('session' in step.context)) return undefined
    return step.context.session
  }

  for (const step of steps) {
    if (step.kind !== 'agent') continue
    let depth = 0
    let current = sessionParentOf(step)
    const seen = new Set<StepId>([step.id])

    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      depth += 1
      const parentStep = stepsById.get(current)
      current = parentStep ? sessionParentOf(parentStep) : undefined
    }

    if (depth > 3) {
      console.warn(
        `step "${step.id}": context.session chain exceeds depth 3 (depth ${depth}) — ` +
          `spec §3.4 discourages long resume chains`,
      )
    }
  }
}
