import { describe, expect, it } from 'vitest'
import { extractTemplateRoots, renderTemplate } from '../../src/expr/template.js'

describe('renderTemplate', () => {
  it('substitutes a whole-artifact placeholder', async () => {
    const out = await renderTemplate('issue: {{issue}}', { issue: { title: 'x' } })
    expect(out).toBe('issue: {"title":"x"}')
  })

  it('substitutes a dotted field-access placeholder', async () => {
    const out = await renderTemplate('title: {{issue.title}}', { issue: { title: 'Fix bug' } })
    expect(out).toBe('title: Fix bug')
  })

  it('substitutes multiple placeholders in order', async () => {
    const out = await renderTemplate('{{a}} then {{b}}', { a: 'first', b: 'second' })
    expect(out).toBe('first then second')
  })

  it('throws at render time on a missing field', async () => {
    await expect(renderTemplate('{{issue.nope}}', { issue: {} })).rejects.toThrow(/resolved to undefined/)
  })

  it('renders an or-default when the root is missing, and the value when it is present', async () => {
    await expect(renderTemplate('{{ security || "none yet" }}', {})).resolves.toBe('none yet')
    await expect(renderTemplate('{{ security || "none yet" }}', { security: 'real' })).resolves.toBe('real')
  })
})

describe('extractTemplateRoots', () => {
  it('extracts the root identifier of a whole-artifact placeholder', () => {
    expect(extractTemplateRoots('{{issue}}')).toEqual(['issue'])
  })

  it('extracts the root identifier of a dotted placeholder', () => {
    expect(extractTemplateRoots('{{issue.title}}')).toEqual(['issue'])
  })

  it('dedupes repeated roots and preserves distinct ones', () => {
    expect(extractTemplateRoots('{{a.x}} {{a.y}} {{b}}')).toEqual(['a', 'b'])
  })

  it('returns an empty list for a template with no placeholders', () => {
    expect(extractTemplateRoots('no placeholders here')).toEqual([])
  })

  it('takes the artifact identifier when the placeholder is an or-default expression', () => {
    expect(extractTemplateRoots('{{ security || "x" }}')).toEqual(['security'])
    expect(extractTemplateRoots('{{ x || "default" }}')).toEqual(['x'])
  })

  it('still takes the root of a dotted expression that falls back with ||', () => {
    expect(extractTemplateRoots('{{ security.findings || "x" }}')).toEqual(['security'])
  })

  it('collects identifiers that are not at the start of the expression', () => {
    expect(extractTemplateRoots('{{ !x }}')).toEqual(['x'])
    expect(extractTemplateRoots('{{ (x) }}')).toEqual(['x'])
    expect(extractTemplateRoots('{{ 1 + y }}')).toEqual(['y'])
  })

  it('collects both operands of ||, including a misspelled one', () => {
    expect(extractTemplateRoots('{{ x || secrity }}')).toEqual(['x', 'secrity'])
  })

  it('collects a call name and its arguments', () => {
    expect(extractTemplateRoots('{{ fn(x) }}')).toEqual(['fn', 'x'])
  })

  it('skips a jexl transform name after | and identifiers inside strings', () => {
    expect(extractTemplateRoots('{{ x | upper }}')).toEqual(['x'])
    expect(extractTemplateRoots('{{ x|upper }}')).toEqual(['x'])
    expect(extractTemplateRoots('{{ x|split(sep) }}')).toEqual(['x', 'sep'])
    expect(extractTemplateRoots('{{ "secrity" }}')).toEqual([])
    expect(extractTemplateRoots("{{ x || 'secrity' }}")).toEqual(['x'])
  })

  it('does not treat jexl literals or the in operator as roots', () => {
    expect(extractTemplateRoots('{{ review.approved == true }}')).toEqual(['review'])
    expect(extractTemplateRoots('{{ item in items }}')).toEqual(['item', 'items'])
  })

  it('does not treat null or undefined as artifact roots', () => {
    expect(extractTemplateRoots('{{ verify.exitCode == null }}')).toEqual(['verify'])
    expect(extractTemplateRoots('{{ x || undefined }}')).toEqual(['x'])
  })

  it('still collects a typo root beside null or undefined', () => {
    expect(extractTemplateRoots('{{ verfy.exitCode == null }}')).toEqual(['verfy'])
    expect(extractTemplateRoots('{{ x || undefind }}')).toEqual(['x', 'undefind'])
  })
})
