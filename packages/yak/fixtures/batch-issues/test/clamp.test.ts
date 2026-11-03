import { describe, expect, it } from 'vitest'
import { clamp } from '../src/clamp.js'

describe('clamp', () => {
  it('leaves an in-range value untouched', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('clamps a value below the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('clamps a value above the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })
})
