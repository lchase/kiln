import { describe, expect, it } from 'vitest'
import { mergeIntervals } from '../src/mergeIntervals.js'

describe('mergeIntervals', () => {
  it('returns an empty array for empty input', () => {
    expect(mergeIntervals([])).toEqual([])
  })

  it('returns a single interval unchanged', () => {
    expect(mergeIntervals([[1, 3]])).toEqual([[1, 3]])
  })

  it('leaves non-overlapping intervals unchanged, sorted by start', () => {
    expect(mergeIntervals([[5, 7], [1, 2]])).toEqual([[1, 2], [5, 7]])
  })

  it('merges overlapping intervals', () => {
    expect(mergeIntervals([[1, 4], [2, 6]])).toEqual([[1, 6]])
  })

  it('merges intervals that only touch at an endpoint', () => {
    expect(mergeIntervals([[1, 3], [3, 6]])).toEqual([[1, 6]])
  })

  it('sorts unsorted input before merging', () => {
    expect(mergeIntervals([[8, 10], [1, 3], [2, 6]])).toEqual([[1, 6], [8, 10]])
  })

  it('merges a chain of overlapping intervals into one', () => {
    expect(mergeIntervals([[1, 2], [2, 3], [3, 4], [4, 5]])).toEqual([[1, 5]])
  })
})
