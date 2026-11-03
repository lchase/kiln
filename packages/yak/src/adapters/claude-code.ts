import { spawn } from 'node:child_process'
import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultError,
  type SpawnedProcess,
  type SpawnOptions as SdkSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { StepFailure } from '../ir/types.js'
import { AgentStepFailedError } from '../steps/agent.js'
import { createAgentSandboxNetwork, type AgentSandboxNetwork } from './sandbox-network.js'
import type { AgentAdapter, AgentAdapterRequest, AgentAdapterResponse } from './types.js'

/** Ticket 07/08 (roadmap map): `docker/agent-sandbox/`'s default image
 * pins the resolved-per-arch CLI binary to this fixed path at build time
 * (see that Dockerfile's comment) — the SDK's own `options.command` is a
 * *host* path (wrong platform, meaningless inside a container), so it's
 * never forwarded; only `options.args` (the portable CLI flags encoding
 * the rest of `Options`) crosses the container boundary. */
const AGENT_SANDBOX_IMAGE_DEFAULT = 'yak-agent-sandbox:latest'
const CONTAINER_CLI_PATH = '/app/claude-cli'
const CONTAINER_WORKDIR = '/workspace'

/** Builds the `docker run` argv for a sandboxed agent step's CLI child
 * process. Pure/exported for testing, same pattern as
 * `command.ts`'s `dockerRunArgs`. Credentials cross via explicit env-var
 * passthrough (ticket 07) — never a mounted `~/.claude`, which would hand
 * the container broader host state than this one run's auth needs. */
export function dockerAgentRunArgs(
  image: string | undefined,
  cwd: string,
  networkName: string,
  proxyUrl: string,
  args: string[],
  hostEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const credentialEnv = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
    .filter((key) => hostEnv[key] !== undefined)
    .flatMap((key) => ['-e', `${key}=${hostEnv[key]}`])

  return [
    'run',
    '--rm',
    '-i',
    '--network',
    networkName,
    '-v',
    `${cwd}:${CONTAINER_WORKDIR}`,
    '-w',
    CONTAINER_WORKDIR,
    '-e',
    `HTTPS_PROXY=${proxyUrl}`,
    '-e',
    `HTTP_PROXY=${proxyUrl}`,
    ...credentialEnv,
    image ?? AGENT_SANDBOX_IMAGE_DEFAULT,
    CONTAINER_CLI_PATH,
    ...args,
  ]
}

/**
 * M2 tickets 01/10: `tools` is the SDK's availability allowlist (not the
 * approval-only `allowedTools` spec.md §5 originally, and incorrectly,
 * named) — it restricts what the model can call independent of
 * `permissionMode`. `bypassPermissions` is the only `permissionMode` that
 * needs no `canUseTool` callback, which yak can't provide (agent steps
 * have no channel to ask a human, spec §3.6). Fixed engine-wide, not a
 * per-step IR field — see ticket 10.
 */
const FIXED_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
} as const

/** File-mutating tools whose `file_path` input we scan for `filesChanged`. */
const FILE_MUTATING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

function collectFilesChanged(message: SDKMessage, into: Set<string>): void {
  if (message.type !== 'assistant') return
  for (const block of message.message.content) {
    if (block.type !== 'tool_use') continue
    if (!FILE_MUTATING_TOOLS.has(block.name)) continue
    const input = block.input
    if (input && typeof input === 'object' && 'file_path' in input) {
      const filePath = (input as { file_path: unknown }).file_path
      if (typeof filePath === 'string') into.add(filePath)
    }
  }
}

/**
 * M2 ticket 04's failure-mode -> StepFailure mapping table. Permission
 * denials are checked ahead of this (they can appear on a success result
 * too); this only classifies the terminal error subtypes.
 */
function mapResultError(result: SDKResultError): StepFailure {
  const detail = result.errors.length > 0 ? result.errors.join('; ') : `${result.subtype} (no detail)`
  switch (result.subtype) {
    case 'error_max_budget_usd':
      return { reason: 'budget-exhausted', detail, recoverable: false }
    case 'error_max_turns':
      // Same prompt/session would hit the same cap again — not schema-repair's job (§3.5 is schema-invalid only).
      return { reason: 'adapter-error', detail, recoverable: false }
    case 'error_max_structured_output_retries':
      return { reason: 'adapter-error', detail, recoverable: false }
    case 'error_during_execution':
    default:
      return { reason: 'adapter-error', detail, recoverable: true }
  }
}

/**
 * Real `AgentAdapter` wrapping the Claude Agent SDK's `query()`. One
 * instance per step invocation — mirrors `MockAdapter`'s per-step
 * construction in `scheduler.ts` — since `sessions/<step>.jsonl` (spec
 * §4.1) needs the run directory and step id that `AgentAdapterRequest`
 * itself doesn't carry.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code'

  constructor(
    private readonly runDir: string,
    private readonly stepId: string,
    /** Set (non-`undefined`) when `AgentStep.sandbox === 'docker'`; `image`
     * is `undefined` for the yak-shipped default. `allowedDomains`, when
     * set, replaces `DEFAULT_ALLOWED_DOMAINS`. See ticket 07/08. */
    private readonly sandbox?: { image?: string; allowedDomains?: string[] },
  ) {}

  async run(req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    const abortController = new AbortController()
    if (req.signal.aborted) abortController.abort(req.signal.reason)
    else req.signal.addEventListener('abort', () => abortController.abort(req.signal.reason))

    let network: AgentSandboxNetwork | undefined
    if (this.sandbox) {
      network =
        this.sandbox.allowedDomains !== undefined
          ? await createAgentSandboxNetwork(this.stepId, this.sandbox.allowedDomains)
          : await createAgentSandboxNetwork(this.stepId)
    }

    const options: Options = {
      ...FIXED_OPTIONS,
      abortController,
      cwd: req.cwd,
      tools: req.tools,
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
      // §3.4 `context: { session }` resume vs `'fresh'` (ticket 06): a
      // prior sessionId genuinely replays that session's transcript via
      // `resume`; omitting it is `'fresh'` — no explicit teardown needed,
      // and this Options object is always freshly built per call, never
      // reused/mutated across steps.
      ...(req.sessionId !== undefined ? { resume: req.sessionId } : {}),
      ...(req.schema !== undefined
        ? { outputFormat: { type: 'json_schema', schema: req.schema as Record<string, unknown> } }
        : {}),
      // Ticket 07/08: substitutes a `docker run` wrapping the CLI child
      // process for the SDK's default local spawn. `spawnOptions.command`
      // (a host path) is deliberately dropped — see dockerAgentRunArgs's
      // doc comment — only `.args` (portable CLI flags) crosses over.
      ...(network
        ? {
            spawnClaudeCodeProcess: (spawnOptions: SdkSpawnOptions): SpawnedProcess =>
              spawn(
                'docker',
                dockerAgentRunArgs(
                  this.sandbox!.image,
                  req.cwd,
                  network!.networkName,
                  network!.proxyUrl,
                  spawnOptions.args,
                ),
                { signal: spawnOptions.signal },
              ),
          }
        : {}),
    }

    try {
      const sessionLogPath = path.join(this.runDir, 'sessions', `${this.stepId}.jsonl`)
      await mkdir(path.dirname(sessionLogPath), { recursive: true })

      const filesChanged = new Set<string>()
      let result: Extract<SDKMessage, { type: 'result' }> | undefined

      // `query()` itself throwing (bad options, the CLI process failing to
      // spawn at all) is a hard infra failure — left to propagate unwrapped,
      // same as a thrown/rejected promise before any message ever arrived.
      // Once the stream is iterating, though, an error thrown mid-stream is
      // a genuine per-turn failure (the SDK wraps some structured-output
      // exhaustion cases this way instead of a `result` message) — same
      // class of thing `mapResultError` below handles, so it needs the same
      // `AgentStepFailedError` wrapping to go through the typed StepFailure
      // path (and, inside a `map`, respect `onItemFailure` instead of
      // hard-failing the whole run).
      const stream = query({ prompt: req.prompt, options })
      try {
        // Ticket 03: write the raw SDKMessage stream verbatim, one JSON
        // object per line, unfiltered — already JSONL-shaped, matches the
        // SDK's own on-disk session format.
        for await (const message of stream) {
          await appendFile(sessionLogPath, `${JSON.stringify(message)}\n`, 'utf8')
          collectFilesChanged(message, filesChanged)
          if (message.type === 'result') result = message
        }
      } catch (err) {
        throw new AgentStepFailedError({
          reason: 'adapter-error',
          detail: `claude-code adapter for step "${this.stepId}": query() stream errored: ${(err as Error).message}`,
          recoverable: true,
        })
      }

      if (!result) {
        // Ticket 04: a thrown/rejected promise around the `for await` loop is
        // one failure mode; a stream that ends with no result message at all
        // (still possible if the process exits without yielding one) is the
        // same class of failure — treated identically.
        throw new AgentStepFailedError({
          reason: 'adapter-error',
          detail: `claude-code adapter for step "${this.stepId}": query() stream ended without a result message`,
          recoverable: true,
        })
      }

      if (result.permission_denials.length > 0) {
        throw new AgentStepFailedError({
          reason: 'tool-denied',
          detail: `tool call(s) denied: ${result.permission_denials.map((d) => d.tool_name).join(', ')}`,
          recoverable: false,
        })
      }

      if (result.subtype !== 'success') {
        throw new AgentStepFailedError(mapResultError(result))
      }

      return {
        output: result.structured_output ?? result.result,
        sessionId: result.session_id,
        tokens: { input: result.usage.input_tokens, output: result.usage.output_tokens },
        filesChanged: [...filesChanged].sort(),
        stopReason: 'complete',
      }
    } finally {
      await network?.teardown()
    }
  }
}
