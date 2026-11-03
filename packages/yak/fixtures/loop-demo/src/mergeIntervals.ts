export type Interval = [number, number]

/**
 * Merge a list of [start, end] intervals into the smallest equivalent
 * set of non-overlapping intervals. Input may be unsorted. Intervals
 * that merely touch at an endpoint (e.g. [1, 3] and [3, 6]) count as
 * overlapping and must be merged into one ([1, 6]).
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  throw new Error('not implemented')
}
