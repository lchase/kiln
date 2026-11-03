import { readFileSync } from 'node:fs'

/**
 * yak's own version, read from the package manifest at runtime.
 *
 * npm always ships `package.json` at the tarball root next to `dist/`, so
 * from the bundled `dist/index.js` it sits at `../package.json`; running
 * unbundled from source (`tsx`, vitest) it's two levels up from
 * `src/cli/`. Try both, and only trust a manifest that is actually yak's.
 */
export function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const manifest = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as {
        name?: string
        version?: string
      }
      if (manifest.name === '@lchase/yak' && manifest.version) return manifest.version
    } catch {
      // not there / not readable — try the next candidate
    }
  }
  return '0.0.0'
}
