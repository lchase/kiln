import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listMapItemArtifacts } from '../../src/engine/artifacts.js'

let dir: string

afterEach(async () => {
  if (dir) {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  }
})

describe('ticket 09: listMapItemArtifacts', () => {
  it('lists only the item indices whose files currently exist, sorted', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'yak-artifacts-map-'))
    const artifactsDir = path.join(dir, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })
    // a partial fan-out — item 1 hasn't landed yet
    await writeFile(path.join(artifactsDir, 'findings.0.json'), '{}', 'utf8')
    await writeFile(path.join(artifactsDir, 'findings.2.json'), '{}', 'utf8')

    const indices = await listMapItemArtifacts(dir, 'findings')

    expect(indices).toEqual([0, 2])
  })

  it('returns an empty list when the run has no artifacts directory yet', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'yak-artifacts-map-'))

    const indices = await listMapItemArtifacts(dir, 'findings')

    expect(indices).toEqual([])
  })

  it('does not match a different produces name with a similar prefix', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'yak-artifacts-map-'))
    const artifactsDir = path.join(dir, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })
    await writeFile(path.join(artifactsDir, 'findings-extra.0.json'), '{}', 'utf8')

    const indices = await listMapItemArtifacts(dir, 'findings')

    expect(indices).toEqual([])
  })
})
