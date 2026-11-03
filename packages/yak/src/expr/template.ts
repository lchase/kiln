import jexl from 'jexl'

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y

/** Not artifact roots. `true`/`false` are jexl literals and `in` is a
 * word-operator. jexl 2.3.0 lexes `null` and `undefined` as identifiers that
 * resolve to `undefined`, so `x == null` works at runtime via loose `==`;
 * validation must not require an artifact with either name. */
const NOT_A_ROOT = new Set(['true', 'false', 'in', 'null', 'undefined'])

/** Every context identifier a `{{...}}` placeholder reads — used by
 * validate.ts's load-time check that each one is in `needs ∪ context.inherit`.
 * Names after `.` are property access, and the name after a single `|` is a
 * jexl transform (`x|upper`). `||` is logical or, so both operands count:
 * `{{ x || secrity }}` roots at `x` and `secrity`. String literals are skipped. */
export function extractTemplateRoots(template: string): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    for (const ident of identifiersInExpr(match[1]!)) {
      if (seen.has(ident)) continue
      seen.add(ident)
      roots.push(ident)
    }
  }
  return roots
}

function identifiersInExpr(expr: string): string[] {
  const found: string[] = []
  let prev: 'dot' | 'pipe' | 'other' = 'other'
  let i = 0

  while (i < expr.length) {
    const c = expr[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '"' || c === "'") {
      i = skipString(expr, i)
      prev = 'other'
      continue
    }
    if (c === '|' && expr[i + 1] === '|') {
      i += 2
      prev = 'other'
      continue
    }
    if (c === '|') {
      i++
      prev = 'pipe'
      continue
    }
    if (c === '.') {
      i++
      prev = 'dot'
      continue
    }

    IDENTIFIER.lastIndex = i
    const ident = IDENTIFIER.exec(expr)
    if (ident && ident.index === i) {
      const name = ident[0]
      if (prev !== 'dot' && prev !== 'pipe' && !NOT_A_ROOT.has(name)) found.push(name)
      i += name.length
      prev = 'other'
      continue
    }

    i++
    prev = 'other'
  }

  return found
}

function skipString(expr: string, start: number): number {
  const quote = expr[start]!
  let i = start + 1
  while (i < expr.length) {
    if (expr[i] === '\\') {
      i += 2
      continue
    }
    if (expr[i] === quote) return i + 1
    i++
  }
  return i
}

export async function renderTemplate(template: string, inputs: Record<string, unknown>): Promise<string> {
  let result = ''
  let lastIndex = 0

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const [full, exprRaw] = match
    const expr = exprRaw!.trim()
    const start = match.index!

    const value = await jexl.eval(expr, inputs)
    if (value === undefined) {
      throw new Error(`prompt template placeholder "{{${expr}}}" resolved to undefined`)
    }

    result += template.slice(lastIndex, start)
    result += typeof value === 'string' ? value : JSON.stringify(value)
    lastIndex = start + full.length
  }

  result += template.slice(lastIndex)
  return result
}
