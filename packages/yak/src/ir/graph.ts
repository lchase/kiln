import type { AgentStep, ArtifactName, MapStep, Step, StepId, Workflow } from './types.js'

export function buildProducerMap(steps: Step[]): Map<ArtifactName, StepId> {
  const producerOf = new Map<ArtifactName, StepId>()
  for (const step of steps) {
    if (step.produces) producerOf.set(step.produces, step.id)
  }
  return producerOf
}

/** The artifact names an agent step's prompt may reference: `needs` plus
 * whatever `context: { inherit }` widens the inputs with (§3.4). */
export function agentInputNames(step: AgentStep): ArtifactName[] {
  const names = new Set(step.needs ?? [])
  if (typeof step.context === 'object' && 'inherit' in step.context) {
    for (const name of step.context.inherit) names.add(name)
  }
  return [...names]
}

/** The artifact names a map step's item iterates or otherwise depends on:
 * `needs` plus `over` — the list a map step fans out over is a real input
 * (the item can't run before it exists) even though authors conventionally
 * duplicate it into `needs` too; this doesn't require that duplication. */
export function mapInputNames(step: MapStep): ArtifactName[] {
  const names = new Set(step.needs ?? [])
  names.add(step.over)
  return [...names]
}

/** A step's full artifact input set — `needs`, widened by `context.inherit`
 * for an agent step or by `over` for a map step. This is what both graph
 * edges and cache keys must be computed from: an inherited or fanned-over
 * artifact is a real input, not just prose. */
export function inputNamesOf(step: Step): ArtifactName[] {
  if (step.kind === 'agent') return agentInputNames(step)
  if (step.kind === 'map') return mapInputNames(step)
  return step.needs ?? []
}

export function dependenciesOf(step: Step, producerOf: Map<ArtifactName, StepId>): StepId[] {
  return inputNamesOf(step)
    .map((need) => producerOf.get(need))
    .filter((id): id is StepId => id !== undefined)
}

/** Producers of `step`'s inputs that sit earlier than `posIndex` in `order`.
 * A loop body waits on these for this round's value. A producer at the same
 * or a later position is not a this-round dependency — it resolves to the
 * previous round. The loop scheduler and validation's overlap walk
 * (`waitsOn`) both use this so the two stay the same rule. */
export function earlierProducerIds(
  step: Step,
  posIndex: number,
  producerOf: Map<ArtifactName, StepId>,
  order: Map<StepId, number>,
): StepId[] {
  const deps: StepId[] = []
  for (const name of inputNamesOf(step)) {
    const producerId = producerOf.get(name)
    if (producerId === undefined) continue
    const producerPos = order.get(producerId)
    if (producerPos !== undefined && producerPos < posIndex) deps.push(producerId)
  }
  return deps
}

/** Every step reachable from `steps`, including a `loop`'s `body` steps and
 * a `map`'s inner `step` — used by the load-time checks that must see into
 * nested steps (duplicate ids, known kinds, agent tool/schema/prompt
 * validity), as opposed to the top-level scheduler, which treats a `loop`
 * or `map` as one opaque node and never dispatches its nested steps itself. */
export function flattenSteps(steps: Step[]): Step[] {
  const result: Step[] = []
  for (const step of steps) {
    result.push(step)
    if (step.kind === 'loop') result.push(...flattenSteps(step.body))
    if (step.kind === 'map') result.push(...flattenSteps([step.step]))
  }
  return result
}

/** t04: `yak graph`'s Mermaid emission — deliberately not gated behind
 * `validateWorkflow` (a caller may want to graph an invalid workflow to see
 * *why* it's invalid). Every step is its own node, including a `loop`'s
 * body or a `map`'s item step — a `loop`/`map` step itself becomes a
 * Mermaid `subgraph` (addressable as an edge endpoint in its own right,
 * same as any node id) rather than a node alongside its nested steps. */
export function renderMermaid(workflow: Workflow): string {
  const producerOf = buildProducerMap(flattenSteps(workflow.steps))
  const lines: string[] = ['flowchart TD']
  renderStepList(workflow.steps, producerOf, lines)
  return lines.join('\n')
}

function renderStepList(steps: Step[], producerOf: Map<ArtifactName, StepId>, lines: string[]): void {
  for (const step of steps) {
    const nested = step.kind === 'loop' ? step.body : step.kind === 'map' ? [step.step] : undefined
    if (nested) {
      lines.push(`  subgraph ${step.id}`)
      renderStepList(nested, producerOf, lines)
      lines.push('  end')
    } else {
      lines.push(`  ${step.id}[${step.id}]`)
    }

    for (const name of inputNamesOf(step)) {
      const producer = producerOf.get(name)
      if (producer) lines.push(`  ${producer} -->|${name}| ${step.id}`)
    }
  }
}
