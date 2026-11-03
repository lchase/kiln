import { describe, expect, it } from 'vitest'
import { promptForAnswer, type FieldPrompt, type FieldSpec } from '../../src/cli/interactive.js'
import type { GatePendingRequest, LoopExhaustedPendingRequest } from '../../src/engine/suspend.js'

function scriptedField(answers: unknown[]): FieldPrompt {
  let i = 0
  return async (field: FieldSpec) => {
    if (i >= answers.length) throw new Error(`scriptedField: ran out of scripted answers for "${field.name}"`)
    return answers[i++]
  }
}

const GATE_REQUEST: GatePendingRequest = {
  kind: 'gate',
  stepId: 'approve',
  runId: 'r1',
  rendered: 'Approve this change?',
  answerSchema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['approve', 'reject'] },
      notes: { type: 'string' },
    },
    required: ['decision'],
  },
  context: { artifacts: [] },
  openedAt: new Date().toISOString(),
}

const LOOP_REQUEST: LoopExhaustedPendingRequest = {
  kind: 'loop-exhausted',
  stepId: 'fix-until-green',
  runId: 'r1',
  tripped: 'maxIterations',
  iteration: 3,
  answerSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['continue', 'abort'] },
      addIterations: { type: 'number' },
    },
    required: ['action'],
  },
  openedAt: new Date().toISOString(),
}

describe('ticket 04: --interactive flat-schema rendering', () => {
  it('prompts required then optional fields in schema order, skipping a blank optional', async () => {
    const answer = await promptForAnswer(GATE_REQUEST, scriptedField(['approve', undefined]))
    expect(answer).toEqual({ decision: 'approve' })
  })

  it('captures an optional field when given', async () => {
    const answer = await promptForAnswer(GATE_REQUEST, scriptedField(['reject', 'looks risky']))
    expect(answer).toEqual({ decision: 'reject', notes: 'looks risky' })
  })

  it('renders the loop-exhaustion built-in schema (ticket 02/08)', async () => {
    const answer = await promptForAnswer(LOOP_REQUEST, scriptedField(['continue', 2]))
    expect(answer).toEqual({ action: 'continue', addIterations: 2 })
  })

  it('announces the gate rendering and the loop-exhaustion summary', async () => {
    const announced: string[] = []
    await promptForAnswer(GATE_REQUEST, scriptedField(['approve', undefined]), (t) => announced.push(t))
    expect(announced[0]).toContain('Approve this change?')

    announced.length = 0
    await promptForAnswer(LOOP_REQUEST, scriptedField(['abort', undefined]), (t) => announced.push(t))
    expect(announced[0]).toContain('maxIterations')
  })

  it('asks each field in schema-declared order', async () => {
    const seen: string[] = []
    const answer = await promptForAnswer(GATE_REQUEST, async (field: FieldSpec) => {
      seen.push(field.name)
      return field.name === 'decision' ? 'approve' : undefined
    })
    expect(seen).toEqual(['decision', 'notes'])
    expect(answer).toEqual({ decision: 'approve' })
  })
})
