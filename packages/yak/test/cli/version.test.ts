import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readVersion } from '../../src/cli/version.js'

describe('readVersion', () => {
  it('returns the version from yak’s own package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(readVersion()).toBe(pkg.version)
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
