import { describe, expect, it } from 'vitest'
import { parseInputPairs } from '../../src/cli/parse-input.js'

describe('parseInputPairs', () => {
  it('returns undefined when nothing is passed', () => {
    expect(parseInputPairs(undefined)).toBeUndefined()
    expect(parseInputPairs([])).toBeUndefined()
  })

  it('parses key=value pairs into an object, values stay strings', () => {
    expect(parseInputPairs(['issueRef=lchase/yak#1', 'attempt=2'])).toEqual({
      issueRef: 'lchase/yak#1',
      attempt: '2',
    })
  })

  it('keeps everything after the first = (values may contain =)', () => {
    expect(parseInputPairs(['q=a=b=c'])).toEqual({ q: 'a=b=c' })
  })

  it('rejects an entry with no =', () => {
    expect(() => parseInputPairs(['issueRef'])).toThrow(/key=value/)
  })

  it('rejects an entry with an empty key', () => {
    expect(() => parseInputPairs(['=value'])).toThrow(/key=value/)
  })

  it('rejects a repeated key rather than silently last-wins', () => {
    expect(() => parseInputPairs(['k=1', 'k=2'])).toThrow(/more than once/)
  })
})
