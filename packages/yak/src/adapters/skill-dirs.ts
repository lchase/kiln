import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Claude Code loads project skills from `<dir>/.claude/skills/<name>/SKILL.md`
 * for every directory the Agent SDK passes as `additionalDirectories`
 * (`--add-dir`). A configured skill directory is already that tree
 * (`<name>/SKILL.md` directly inside it). Each one is linked, not copied,
 * from a private wrapper, and the wrapper is what the SDK is given.
 *
 * The wrapper is a real `.claude/skills` directory whose children are
 * symlinks. The sandbox mounts the wrapper and the skill directory
 * read-only at the same host paths. `~/.claude` is not one of those paths.
 */
export interface SkillSearch {
  /** Absolute directories for `options.additionalDirectories`. */
  additionalDirectories: string[]
  /**
   * Host paths to mount read-only at the same path inside the sandbox.
   * The wrapper plus each skill directory. Empty when nothing was configured.
   */
  mountPaths: string[]
  cleanup(): void
}

export function prepareSkillSearch(skillDirs: readonly string[] | undefined): SkillSearch {
  const dirs = existingSkillDirs(skillDirs ?? [])
  if (dirs.length === 0) {
    return { additionalDirectories: [], mountPaths: [], cleanup() {} }
  }

  const root = mkdtempSync(path.join(tmpdir(), 'yak-skills-'))
  const additionalDirectories: string[] = []
  const mountPaths = [root]
  try {
    for (let index = 0; index < dirs.length; index += 1) {
      const skillDir = dirs[index]!
      const wrapper = path.join(root, String(index))
      const skillsRoot = path.join(wrapper, '.claude', 'skills')
      mkdirSync(skillsRoot, { recursive: true })
      for (const name of readdirSync(skillDir)) {
        if (name.startsWith('.')) continue
        symlinkSync(path.join(skillDir, name), path.join(skillsRoot, name))
      }
      additionalDirectories.push(wrapper)
      mountPaths.push(skillDir)
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }

  return {
    additionalDirectories,
    mountPaths,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function existingSkillDirs(skillDirs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of skillDirs) {
    if (!dir.startsWith('/') || dir.includes(':') || dir.includes('\0')) {
      throw new Error(
        `Skill directory ${JSON.stringify(dir)} must be an absolute path without ':' so it can be mounted read-only.`,
      )
    }
    if (!existsSync(dir)) continue
    if (!statSync(dir).isDirectory()) {
      throw new Error(`Skill directory ${dir} is not a directory.`)
    }
    const real = realpathSync(dir)
    if (seen.has(real)) continue
    seen.add(real)
    out.push(real)
  }
  return out
}
