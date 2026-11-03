import { describe, expect, it } from 'vitest'
import { isPalindrome } from '../src/isPalindrome.js'

describe('isPalindrome', () => {
  it('recognizes a simple palindrome', () => {
    expect(isPalindrome('racecar')).toBe(true)
  })

  it('rejects a non-palindrome', () => {
    expect(isPalindrome('hello')).toBe(false)
  })

  it('ignores case, spaces, and punctuation', () => {
    expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true)
  })
})
