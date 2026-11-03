import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { normalizeWorkflow } from '../../src/ir/normalize.js'
import type { AgentStep, CommandStep } from '../../src/ir/types.js'

/** The shape Kiln injects under each `agent:` block (lchase/kiln#25). */
const KILN_AGENT_YAML = `
name: kiln
version: "1"
steps:
  - id: spec
    agent:
      prompt:
        inline: hello
      sandbox: docker
      image: "yak-agent-sandbox:latest"
      allowedDomains:
        - api.anthropic.com
        - registry.npmjs.org
        - github.com
        - api.github.com
        - codeload.github.com
        - objects.githubusercontent.com
        - raw.githubusercontent.com
`

describe('sandbox fields from workflow YAML', () => {
  it('loads sandbox, image, and allowedDomains from an agent step', () => {
    const workflow = normalizeWorkflow(parse(KILN_AGENT_YAML))
    const step = workflow.steps[0] as AgentStep
    expect(step.kind).toBe('agent')
    expect(step.sandbox).toBe('docker')
    expect(step.image).toBe('yak-agent-sandbox:latest')
    expect(step.allowedDomains).toEqual([
      'api.anthropic.com',
      'registry.npmjs.org',
      'github.com',
      'api.github.com',
      'codeload.github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
    ])
  })

  it('omits allowedDomains when the agent step does not set it', () => {
    const workflow = normalizeWorkflow(
      parse(`
name: w
version: "1"
steps:
  - id: spec
    agent:
      prompt:
        inline: hello
      sandbox: docker
`),
    )
    const step = workflow.steps[0] as AgentStep
    expect(step.sandbox).toBe('docker')
    expect(step.image).toBeUndefined()
    expect(step.allowedDomains).toBeUndefined()
  })

  it('loads sandbox and image from a command step', () => {
    const workflow = normalizeWorkflow(
      parse(`
name: w
version: "1"
steps:
  - id: test
    command:
      run: npm test
      sandbox: docker
      image: node:22
`),
    )
    const step = workflow.steps[0] as CommandStep
    expect(step.sandbox).toBe('docker')
    expect(step.image).toBe('node:22')
  })

  it('keeps the raw.agent.allowedDomains access Kiln searches for in the bundle', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/ir/normalize.ts'), 'utf8')
    expect(src).toContain('raw.agent.allowedDomains')
  })
})
