import path from 'node:path'
import { pathToFileURL } from 'node:url'
import jexl from 'jexl'
import type { Expr } from '../ir/types.js'

/** Ticket 02: `until`/`noProgress.signal` evaluation. Takes whatever context
 * the caller resolved (the scheduler pre-resolves it — this module stays
 * iteration-agnostic, same context shape whether it's iteration 1 or 40).
 * `{ fn }` resolves against `.yak/predicates.ts`, the same resolver pattern
 * as `.yak/schemas.ts` and `.yak/transforms.ts`. */
export async function evalExpr(
  expr: Expr,
  context: Record<string, unknown>,
  cwd: string,
): Promise<unknown> {
  if (typeof expr === 'string') {
    return jexl.eval(expr, context)
  }

  const modulePath = path.resolve(cwd, '.yak/predicates.ts')
  const mod: Record<string, unknown> = await import(pathToFileURL(modulePath).href)
  const impl = mod[expr.fn]
  if (typeof impl !== 'function') {
    throw new Error(`predicate "${expr.fn}" not found in .yak/predicates.ts`)
  }
  return (impl as (ctx: Record<string, unknown>) => unknown)(context)
}
