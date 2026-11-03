import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { ZodBoolean, ZodDefault, ZodEnum, ZodNumber, ZodObject, ZodOptional, ZodString, ZodType, toJSONSchema, type ZodError } from 'zod'
import type { JSONSchema } from './types.js'

/** `AgentStep.schema` / `GateStep.schema`: a named ref into `.yak/schemas.ts`
 * (Zod, full power — coercion/`.transform()`/`.refine()`), or an inline JSON
 * Schema (ajv, structural only). See roadmap map ticket 09 / M1 ticket 08. */
export type SchemaSpec = string | { inline: JSONSchema }

export interface SchemaParseResult {
  success: boolean
  data?: unknown
  errorSummary?: string
}

export interface FlatAnswerCheck {
  ok: boolean
  reason?: string
}

/** One shape both branches resolve to, so `agent.ts`/`gate.ts`/`validate.ts`
 * never need to know which branch produced a step's schema. */
export interface ResolvedSchema {
  toJsonSchema(): object
  safeParse(value: unknown): SchemaParseResult
  /** Parses `{}` through the schema, applying defaults — gate's `skipIf`
   * auto-answer path. */
  parseDefaults(): SchemaParseResult
  /** M4 ticket 04: `--interactive` only renders a flat top-level object of
   * scalar/enum properties. */
  isFlatAnswerObject(): FlatAnswerCheck
}

async function resolveZodSchema(name: string, cwd: string): Promise<ZodType> {
  const modulePath = path.resolve(cwd, '.yak/schemas.ts')
  const mod: Record<string, unknown> = await import(pathToFileURL(modulePath).href)
  const schema = mod[name]
  if (!(schema instanceof ZodType)) {
    throw new Error(`schema "${name}" not found in .yak/schemas.ts`)
  }
  return schema
}

/** One line per issue: `path.to.field: <zod's own message>` — zod's default
 * `invalid_type` message already reads "Expected X, received Y". */
function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
}

class ZodResolvedSchema implements ResolvedSchema {
  constructor(private readonly schema: ZodType) {}

  toJsonSchema(): object {
    return toJSONSchema(this.schema)
  }

  safeParse(value: unknown): SchemaParseResult {
    const parsed = this.schema.safeParse(value)
    if (parsed.success) return { success: true, data: parsed.data }
    return { success: false, errorSummary: formatZodError(parsed.error) }
  }

  parseDefaults(): SchemaParseResult {
    return this.safeParse({})
  }

  isFlatAnswerObject(): FlatAnswerCheck {
    if (!(this.schema instanceof ZodObject)) {
      return { ok: false, reason: 'must be a top-level object' }
    }
    for (const [field, fieldSchemaRaw] of Object.entries(this.schema.shape as Record<string, ZodType>)) {
      let fieldSchema: ZodType = fieldSchemaRaw
      while (fieldSchema instanceof ZodOptional || fieldSchema instanceof ZodDefault) {
        fieldSchema = fieldSchema.unwrap() as ZodType
      }
      const isScalar =
        fieldSchema instanceof ZodString || fieldSchema instanceof ZodNumber || fieldSchema instanceof ZodBoolean
      if (!isScalar && !(fieldSchema instanceof ZodEnum)) {
        return { ok: false, reason: `field "${field}" is not a flat scalar/enum type` }
      }
    }
    return { ok: true }
  }
}

/** `useDefaults` so gate's `parseDefaults()` can synthesize an answer from
 * `{}` the same way Zod's `.default()` does; `allErrors` so the repair-loop
 * suffix (and the flat-answer-schema checks) get every issue, not just the
 * first. `strict: false` — workflow authors get ajv's permissive dialect,
 * not its opinionated lint mode. */
const ajv = new Ajv({ useDefaults: true, allErrors: true, strict: false })

/** One line per issue, same `path: message` shape `formatZodError` produces
 * — the repair-loop suffix looks identical regardless of which branch
 * produced the schema. `instancePath` is `''` for a root-level error. */
function formatAjvErrors(errors: ErrorObject[]): string {
  return errors.map((err) => `${err.instancePath.replace(/^\//, '').replace(/\//g, '.')}: ${err.message}`).join('\n')
}

class JsonResolvedSchema implements ResolvedSchema {
  private readonly validateFn: ValidateFunction

  constructor(private readonly schema: JSONSchema) {
    this.validateFn = ajv.compile(schema)
  }

  toJsonSchema(): object {
    return this.schema
  }

  safeParse(value: unknown): SchemaParseResult {
    // ajv's useDefaults mutates the object passed in — clone so callers
    // never see their input mutated out from under them.
    const data = value !== null && typeof value === 'object' ? structuredClone(value) : value
    const valid = this.validateFn(data)
    if (valid) return { success: true, data }
    return { success: false, errorSummary: formatAjvErrors(this.validateFn.errors ?? []) }
  }

  parseDefaults(): SchemaParseResult {
    return this.safeParse({})
  }

  isFlatAnswerObject(): FlatAnswerCheck {
    const schema = this.schema
    if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) {
      return { ok: false, reason: 'must be a top-level object' }
    }
    for (const [field, fieldSchemaRaw] of Object.entries(schema.properties as Record<string, JSONSchema>)) {
      const type = fieldSchemaRaw.type
      const isScalar = type === 'string' || type === 'number' || type === 'integer' || type === 'boolean'
      const isEnum = Array.isArray(fieldSchemaRaw.enum)
      if (!isScalar && !isEnum) {
        return { ok: false, reason: `field "${field}" is not a flat scalar/enum type` }
      }
    }
    return { ok: true }
  }
}

/** Wraps a plain Zod schema (e.g. a fixed built-in like the loop-exhaustion
 * answer schema) as a `ResolvedSchema`, so callers that mix a `SchemaSpec`-
 * resolved schema with a hardcoded Zod one can treat both uniformly. */
export function wrapZodSchema(schema: ZodType): ResolvedSchema {
  return new ZodResolvedSchema(schema)
}

/**
 * Resolves either branch of a `SchemaSpec` to one `ResolvedSchema`. The
 * named-ref branch dynamic-`import()`s `.yak/schemas.ts` (mirrors
 * `resolveTransformFn`); the inline branch compiles the JSON Schema with
 * ajv on the spot — `ajv.compile` itself validates the document against its
 * meta-schema, so a malformed inline schema throws here exactly like a
 * missing named-ref key throws in the caller.
 */
export async function resolveSchemaSpec(spec: SchemaSpec, cwd: string): Promise<ResolvedSchema> {
  if (typeof spec === 'string') {
    return new ZodResolvedSchema(await resolveZodSchema(spec, cwd))
  }
  return new JsonResolvedSchema(spec.inline)
}

/** For error messages that need to name the schema without resolving it. */
export function describeSchemaSpec(spec: SchemaSpec): string {
  return typeof spec === 'string' ? `"${spec}"` : 'inline schema'
}
