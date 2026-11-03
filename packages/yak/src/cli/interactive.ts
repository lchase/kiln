import { createInterface } from 'node:readline'
import { confirm, isCancel, select, text } from '@clack/prompts'
import type { PendingRequest } from '../engine/suspend.js'

interface JsonSchemaProp {
  type?: string
  enum?: string[]
}

interface ObjectJsonSchema {
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
}

export interface FieldSpec {
  name: string
  prop: JsonSchemaProp
  required: boolean
}

/** One schema field in, one typed value out (`undefined` for "left blank,
 * optional") — an interface rather than a raw prompt call so tests can
 * script answers without a real terminal, and so the real implementation
 * (`clackFieldPrompt`) is free to pick whatever widget suits the field
 * (a `select` menu for an enum, a validated `text` box for everything
 * else) instead of every field going through one generic string prompt. */
export type FieldPrompt = (field: FieldSpec) => Promise<unknown>

/** Thrown by `clackFieldPrompt` when the user hits Ctrl+C mid-prompt —
 * distinct from a real error so callers can print a clean "cancelled"
 * message instead of a stack trace and leave the run exactly as
 * suspended, no partial answer written. */
export class PromptCancelledError extends Error {
  constructor() {
    super('prompt cancelled')
  }
}

/**
 * M4 ticket 04: `--interactive` only renders a flat answer schema —
 * top-level object, scalar/enum properties, one prompt per property in
 * schema order (`ir/validate.ts`'s `checkFlatAnswerSchema` rejects
 * anything else at load time, so this never has to handle a shape it
 * can't render).
 */
export async function promptForAnswer(
  request: PendingRequest,
  promptField: FieldPrompt,
  announce: (text: string) => void = () => {},
): Promise<Record<string, unknown>> {
  if (request.kind === 'gate') {
    announce(request.rendered)
  } else {
    announce(`loop "${request.stepId}" exhausted (${request.tripped}) at iteration ${request.iteration}`)
  }

  const schema = request.answerSchema as ObjectJsonSchema
  const required = new Set(schema.required ?? [])
  const answer: Record<string, unknown> = {}

  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const value = await promptField({ name, prop, required: required.has(name) })
    if (value !== undefined) answer[name] = value
  }

  return answer
}

/** The real terminal implementation: an enum renders as an arrow-key
 * `select` menu, everything else as a `text` box with inline validation
 * (clack re-prompts on its own for an invalid or missing required value —
 * no manual retry loop needed here). */
export function clackFieldPrompt(): FieldPrompt {
  return async ({ name, prop, required }) => {
    if (prop.enum) {
      const result = await select({
        message: name,
        options: prop.enum.map((value) => ({ value, label: value })),
      })
      if (isCancel(result)) throw new PromptCancelledError()
      return result
    }

    if (prop.type === 'boolean') {
      const result = await confirm({ message: name })
      if (isCancel(result)) throw new PromptCancelledError()
      return result
    }

    const raw = await text({
      message: required ? name : `${name} (optional)`,
      placeholder: required ? undefined : 'blank to skip',
      validate(value) {
        if (!value) return required ? 'required' : undefined
        if (prop.type === 'number' && Number.isNaN(Number(value))) return 'must be a number'
        return undefined
      },
    })
    if (isCancel(raw)) throw new PromptCancelledError()
    if (raw === '') return undefined
    return prop.type === 'number' ? Number(raw) : raw
  }
}

/** clack's `select`/`text`/`confirm` drive themselves off raw keypress
 * events — piped, non-TTY input (a script feeding canned answers, a CI
 * job, `printf ... | yak run --interactive`) gets its bytes parsed as
 * keystrokes instead of typed characters and never resolves correctly.
 * This is the plain line-based fallback for exactly that case: one
 * `readline` line per field, same validate-and-reprompt loop the CLI used
 * before clack. Callers pick this or `clackFieldPrompt` based on
 * `stdin`/`stdout` actually being a TTY. */
export function lineFieldPrompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): { promptField: FieldPrompt; close: () => void } {
  const rl = createInterface({ input, output })
  const queued: string[] = []
  const waiters: Array<(line: string) => void> = []

  rl.on('line', (line: string) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else queued.push(line)
  })

  const askLine = (question: string): Promise<string> => {
    output.write(question)
    const queuedLine = queued.shift()
    if (queuedLine !== undefined) return Promise.resolve(queuedLine)
    return new Promise((resolve) => waiters.push(resolve))
  }

  const promptField: FieldPrompt = async ({ name, prop, required }) => {
    const label = required ? name : `${name} (optional, blank to skip)`

    for (;;) {
      const raw = (await askLine(prop.enum ? `${label} [${prop.enum.join('/')}]: ` : `${label}: `)).trim()

      if (!raw) {
        if (!required) return undefined
        continue
      }
      if (prop.enum && !prop.enum.includes(raw)) continue
      if (prop.type === 'number') {
        const n = Number(raw)
        if (Number.isNaN(n)) continue
        return n
      }
      if (prop.type === 'boolean') return /^y(es)?$/i.test(raw)
      return raw
    }
  }

  return { promptField, close: () => rl.close() }
}
