import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { dockerAgentRunArgs } from '../../src/adapters/claude-code.js'
import { prepareSkillSearch } from '../../src/adapters/skill-dirs.js'
import { normalizeWorkflow } from '../../src/ir/normalize.js'
import type { AgentStep } from '../../src/ir/types.js'

const keep: string[] = []

afterEach(() => {
  for (const dir of keep.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('prepareSkillSearch', () => {
  it('links a skill tree into .claude/skills without copying it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yak-skill-src-'))
    keep.push(root)
    const skillDir = path.join(root, 'skills')
    const skill = path.join(skillDir, 'widget')
    mkdirSync(skill, { recursive: true })
    writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: widget\ndescription: Fictional\n---\nLook.\n')

    const search = prepareSkillSearch([skillDir, path.join(root, 'missing')])
    try {
      expect(search.additionalDirectories).toHaveLength(1)
      const wrapper = search.additionalDirectories[0]!
      const link = path.join(wrapper, '.claude', 'skills', 'widget')
      expect(readlinkSync(link)).toBe(path.join(realpathSync(skillDir), 'widget'))
      expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toMatch(/Fictional/)
      expect(search.mountPaths).toEqual(expect.arrayContaining([realpathSync(skillDir), path.dirname(wrapper)]))
      expect(search.mountPaths.some((mount) => mount.endsWith(`${path.sep}.claude`))).toBe(false)
    } finally {
      search.cleanup()
    }
    expect(() => readlinkSync(path.join(search.additionalDirectories[0]!, '.claude', 'skills', 'widget'))).toThrow()
  })

  it('is a no-op when no skill directories exist', () => {
    const search = prepareSkillSearch(undefined)
    expect(search.additionalDirectories).toEqual([])
    expect(search.mountPaths).toEqual([])
    search.cleanup()
  })

  it('rejects a relative skill path', () => {
    expect(() => prepareSkillSearch(['skills'])).toThrow(/absolute path/)
  })
})

describe('skillDirs on an agent step', () => {
  it('keeps skillDirs from workflow YAML and the bundle marker', () => {
    const workflow = normalizeWorkflow(
      parse(`
name: w
version: "1"
steps:
  - id: explore
    agent:
      prompt:
        inline: hello
      skillDirs:
        - /home/operator/.kiln/skills
        - /home/operator/skills
`),
    )
    const step = workflow.steps[0] as AgentStep
    expect(step.skillDirs).toEqual(['/home/operator/.kiln/skills', '/home/operator/skills'])
    const src = readFileSync(path.join(process.cwd(), 'src/ir/normalize.ts'), 'utf8')
    expect(src).toContain('raw.agent.skillDirs')
  })

  it('mounts those directories read-only and still does not mount ~/.claude', () => {
    const argv = dockerAgentRunArgs(
      undefined,
      '/work',
      'net1',
      'http://net1-proxy:3128',
      ['--print', 'hi'],
      {},
      ['/home/operator/skills', '/tmp/yak-skills-abc'],
    )
    const worktree = argv.indexOf('/work:/workspace')
    const skill = argv.indexOf('/home/operator/skills:/home/operator/skills:ro')
    const wrapper = argv.indexOf('/tmp/yak-skills-abc:/tmp/yak-skills-abc:ro')
    expect(worktree).toBeGreaterThan(-1)
    expect(skill).toBeGreaterThan(worktree)
    expect(wrapper).toBeGreaterThan(skill)
    expect(argv.some((arg) => arg.includes('/.claude'))).toBe(false)
    expect(argv).toContain('/work:/workspace')
  })
})
