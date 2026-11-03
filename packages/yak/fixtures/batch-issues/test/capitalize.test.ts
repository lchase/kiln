import { describe, expect, it } from 'vitest'
import { capitalize } from '../src/capitalize.js'

describe('capitalize', () => {
  it('uppercases the first letter', () => {
    expect(capitalize('hello')).toBe('Hello')
  })

  it('leaves the rest of the string untouched', () => {
    expect(capitalize('hELLO')).toBe('HELLO')
  })
})
