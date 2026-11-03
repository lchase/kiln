/**
 * `yak run --input key=value` (repeatable) → a plain object (yak#27).
 *
 * Values stay strings — the workflow's `inputSchema` is where any coercion
 * happens (`z.coerce.number()` etc.). A repeated key is a hard error, not a
 * silent last-wins; an entry with no `=` (or a leading `=`) is rejected.
 * Returns `undefined` when nothing was passed, so callers can tell "no
 * --input" from "--input with an empty object".
 */
export function parseInputPairs(pairs: string[] | undefined): Record<string, string> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new Error(`--input must be key=value, got "${pair}"`)
    }
    const key = pair.slice(0, eq)
    if (key in out) throw new Error(`--input key "${key}" given more than once`)
    out[key] = pair.slice(eq + 1)
  }
  return out
}
