import { describe, expect, it } from 'vitest'
import { renderMermaid } from '../../src/ir/graph.js'
import type { AgentStep, CommandStep, LoopStep, MapStep, Step, Workflow } from '../../src/ir/types.js'

function workflow(steps: Step[]): Workflow {
  return { name: 'w', version: '1', steps }
}

function command(overrides: Partial<CommandStep> & Pick<CommandStep, 'id'>): CommandStep {
  return { kind: 'command', run: 'echo hi', ...overrides }
}

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id'>): AgentStep {
  return { kind: 'agent', prompt: { inline: 'hi' }, ...overrides }
}

function map(overrides: Partial<MapStep> & Pick<MapStep, 'id' | 'over' | 'step'>): MapStep {
  return { kind: 'map', isolation: 'none', ...overrides }
}

function loop(overrides: Partial<LoopStep> & Pick<LoopStep, 'id' | 'body' | 'until'>): LoopStep {
  return { kind: 'loop', budget: { maxIterations: 3 }, ...overrides }
}

describe('renderMermaid', () => {
  it('starts with a flowchart TD header', () => {
    const wf = workflow([command({ id: 'a' })])
    expect(renderMermaid(wf)).toMatch(/^flowchart TD\n/)
  })

  it('renders every step as its own node', () => {
    const wf = workflow([
      command({ id: 'a', produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    const out = renderMermaid(wf)
    expect(out).toContain('a[a]')
    expect(out).toContain('b[b]')
  })

  it('labels edges with the artifact name flowing along them', () => {
    const wf = workflow([
      command({ id: 'a', produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    const out = renderMermaid(wf)
    expect(out).toContain('a -->|a-out| b')
  })

  it('an agent step\'s edges include context.inherit artifacts, not just needs', () => {
    const wf = workflow([
      command({ id: 'a', produces: 'a-out' }),
      command({ id: 'b', produces: 'b-out' }),
      agent({ id: 'c', needs: ['a-out'], context: { inherit: ['b-out'] } }),
    ])
    const out = renderMermaid(wf)
    expect(out).toContain('a -->|a-out| c')
    expect(out).toContain('b -->|b-out| c')
  })

  it('renders a loop step as a subgraph boxing its body steps, not a plain node', () => {
    const wf = workflow([
      loop({
        id: 'fix-until-green',
        until: 'done',
        body: [
          command({ id: 'implement', produces: 'code' }),
          command({ id: 'test', needs: ['code'], produces: 'testresult' }),
        ],
      }),
    ])
    const out = renderMermaid(wf)
    expect(out).toContain('subgraph fix-until-green')
    expect(out).not.toContain('fix-until-green[fix-until-green]')
    expect(out).toContain('implement[implement]')
    expect(out).toContain('test[test]')
    expect(out).toContain('implement -->|code| test')
    expect(out).toMatch(/subgraph fix-until-green[\s\S]*end/)
  })

  it('renders a map step as a subgraph boxing its item step, not a plain node', () => {
    const wf = workflow([
      command({ id: 'files', produces: 'changed-files' }),
      map({
        id: 'review',
        needs: ['changed-files'],
        over: 'changed-files',
        step: command({ id: 'review-one', run: 'echo review' }),
      }),
    ])
    const out = renderMermaid(wf)
    expect(out).toContain('subgraph review')
    expect(out).not.toContain('review[review]')
    expect(out).toContain('review-one[review-one]')
    expect(out).toContain('files -->|changed-files| review')
  })

  it("draws the producer edge for a map step's over, even when it's not duplicated into needs", () => {
    const wf = workflow([
      command({ id: 'files', produces: 'changed-files' }),
      map({
        id: 'review',
        over: 'changed-files',
        step: command({ id: 'review-one', run: 'echo review' }),
      }),
    ])
    const out = renderMermaid(wf)
    expect(out).toContain('files -->|changed-files| review')
  })

  it('does not throw on a workflow that would fail load-time validation (e.g. a dangling need)', () => {
    const wf = workflow([command({ id: 'a', needs: ['missing'] })])
    expect(() => renderMermaid(wf)).not.toThrow()
  })
})
