import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z, type ZodType } from 'zod'
import { sha256 } from '../util/hash.js'

/** Same pattern as `cache.ts`'s `writeCacheEntry` — write to a per-write
 * temp file in the target directory, then `rename` into place. `rename`
 * within the same filesystem is atomic, so a crash or a concurrent
 * reader never observes a torn/partial write — see the roadmap map's
 * concurrency-safety audit (ticket 06). */
async function writeFileAtomic(finalPath: string, content: string): Promise<void> {
  const tmpPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${randomUUID()}.tmp`)
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, finalPath)
}

export interface WrittenArtifact {
  name: string
  hash: string
  bytes: number
  path: string
}

/** Ticket 10: a loop body step's artifact gets a per-iteration file,
 * `artifacts/<name>.<iteration>.json`, by analogy with ticket 06's map
 * convention (`<produces>.<index>.json`) — every iteration's output
 * persists, needed for resume to verify a specific completed iteration's
 * cache-key match and for `yak status`/`yak artifacts` to show iteration
 * history. `iteration` omitted keeps the flat, non-loop path unchanged. */
function artifactPath(runDir: string, name: string, iteration?: number): string {
  const fileName = iteration === undefined ? `${name}.json` : `${name}.${iteration}.json`
  return path.join(runDir, 'artifacts', fileName)
}

export async function writeArtifact<T>(
  runDir: string,
  name: string,
  value: T,
  schema: ZodType<T>,
  iteration?: number,
): Promise<WrittenArtifact> {
  const parsed = schema.parse(value)
  const json = JSON.stringify(parsed, null, 2)
  await mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  const filePath = artifactPath(runDir, name, iteration)
  await writeFileAtomic(filePath, json)
  return { name, hash: sha256(json), bytes: Buffer.byteLength(json), path: filePath }
}

export async function readArtifact<T>(
  runDir: string,
  name: string,
  schema: ZodType<T>,
  iteration?: number,
): Promise<T> {
  const json = await readFile(artifactPath(runDir, name, iteration), 'utf8')
  return schema.parse(JSON.parse(json))
}

export async function readArtifactRaw(runDir: string, name: string, iteration?: number): Promise<unknown> {
  return readArtifact(runDir, name, z.unknown(), iteration)
}

/** A `finally: true` step's `needs` may name an artifact whose producer
 * failed and so never wrote it — that's expected, not a bug, so it
 * resolves to `undefined` instead of throwing. Any other missing-artifact
 * read (a step that isn't `finally`) still throws: that indicates a real
 * graph/scheduling bug, not an outcome the step should route around. */
export async function readArtifactRawOrUndefined(runDir: string, name: string): Promise<unknown> {
  try {
    return await readArtifactRaw(runDir, name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** Ticket 09: which of a `map` step's per-item files currently exist on
 * disk, sorted by index — works whether the fan-out is complete or still
 * partial (a live or interrupted run), since it globs the numbered files
 * already there rather than assuming the assembled array exists yet. */
export async function listMapItemArtifacts(runDir: string, produces: string): Promise<number[]> {
  const dir = path.join(runDir, 'artifacts')
  const entries = await readdir(dir).catch(() => [] as string[])
  const escaped = produces.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}\\.(\\d+)\\.json$`)

  return entries
    .map((name) => re.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

/** §3.5 schema repair loop, on final exhaustion: preserve the raw (still
 * schema-invalid) output the step actually produced, for inspection. */
export async function writeRejectedOutput(
  runDir: string,
  stepId: string,
  attempt: number,
  content: string,
): Promise<string> {
  const dir = path.join(runDir, 'artifacts', '.rejected')
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${stepId}.${attempt}.txt`)
  await writeFileAtomic(filePath, content)
  return filePath
}
