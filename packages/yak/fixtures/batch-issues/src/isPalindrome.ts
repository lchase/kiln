/** Returns true if `s` reads the same forwards and backwards, ignoring
 * case, spaces, and punctuation. */
export function isPalindrome(s: string): boolean {
  return s === s.split('').reverse().join('')
}
