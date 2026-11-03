import { describe, expect, it } from 'vitest'
import { titleCase } from '../src/titleCase.js'

describe('titleCase', () => {
  it('capitalizes a single word', () => {
    expect(titleCase('hello')).toBe('Hello')
  })

  it('capitalizes every word by default', () => {
    expect(titleCase('quick brown fox')).toBe('Quick Brown Fox')
  })

  it('lowercases small connector words mid-title', () => {
    expect(titleCase('the lord of the rings')).toBe('The Lord of the Rings')
  })

  it('capitalizes a connector word if it is the first word', () => {
    expect(titleCase('a tale of two cities')).toBe('A Tale of Two Cities')
  })

  it('lowercases the rest of an already-shouty word', () => {
    expect(titleCase('HELLO WORLD')).toBe('Hello World')
  })

  it('returns an empty string unchanged', () => {
    expect(titleCase('')).toBe('')
  })
})
