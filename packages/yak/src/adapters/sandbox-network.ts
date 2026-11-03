import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Ticket 07: agent steps need the Anthropic API, so containment here is a
 * network *allowlist*, not `command` steps' `--network none` (ticket 04/05).
 * `api.anthropic.com` is the only domain the `claude-code` CLI itself talks
 * to for a `query()` call — statsig/telemetry endpoints are not included
 * since yak's `bypassPermissions` + fixed `Options` never opts into them.
 * A step's `allowedDomains` replaces this list; omitting it keeps it. */
export const DEFAULT_ALLOWED_DOMAINS = ['api.anthropic.com']

/** Built from `docker/agent-proxy/` — see that directory's Dockerfile.
 * Not yak-published; built locally (`docker build`) same as the default
 * agent-sandbox image (`docker/agent-sandbox/`). */
const PROXY_IMAGE = 'yak-agent-sandbox-proxy:latest'
const PROXY_PORT = 3128

/** Squid prints this to cache.log and, with `-d 1`, to stderr once it is
 * accepting connections on `PROXY_PORT`. */
export const PROXY_READY_LOG = 'Accepting HTTP'
export const PROXY_READY_TIMEOUT_MS = 15_000
export const PROXY_READY_POLL_MS = 200

/** Overrides egress-network detection. Podman has no network named
 * `bridge`; its default is `podman`. */
export const EGRESS_NETWORK_ENV = 'YAK_SANDBOX_EGRESS_NETWORK'

export interface CommandOutput {
  stdout: string
  stderr: string
}

/** Injected by tests. Production uses the `docker` CLI on PATH (which may
 * be a Podman shim) and the process environment. */
export interface SandboxRuntime {
  exec(args: string[]): Promise<CommandOutput>
  sleep(ms: number): Promise<void>
  now(): number
  env: NodeJS.ProcessEnv
  networkExists(name: string): Promise<boolean>
}

export interface AgentSandboxNetwork {
  networkName: string
  /** `HTTP_PROXY`/`HTTPS_PROXY` value for the agent container — routes all
   * egress through the allowlisting proxy sidecar on this network. */
  proxyUrl: string
  teardown(): Promise<void>
}

function randomSuffix(): string {
  return randomBytes(4).toString('hex')
}

/** Docker network/container names are restricted to `[a-zA-Z0-9_.-]` —
 * step ids aren't guaranteed to satisfy that, so sanitize rather than
 * trusting the workflow author's id choice. */
export function sandboxNetworkName(stepId: string): string {
  return `yak-agent-${stepId.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomSuffix()}`
}

export function proxyContainerName(networkName: string): string {
  return `${networkName}-proxy`
}

/** `--internal`: no default route to the outside world for anything
 * attached to this network. The proxy is the only member that also sits
 * on the egress network, and it is attached there *first* so its resolver
 * is the egress network's (see `startProxyArgs`). */
export function createNetworkArgs(networkName: string): string[] {
  return ['network', 'create', '--internal', networkName]
}

export function removeNetworkArgs(networkName: string): string[] {
  return ['network', 'rm', networkName]
}

/** Start the proxy on the egress network. `docker run --network` only
 * accepts one network, so the internal leg is attached afterwards.
 *
 * Podman (netavark/aardvark-dns) takes a container's resolver from its
 * first network, and aardvark answers NXDOMAIN for external names on an
 * `--internal` network. Creating the proxy there and then connecting
 * `bridge` makes every allowed CONNECT return 503. */
export function startProxyArgs(egressNetwork: string, containerName: string, allowedDomains: string[]): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '--network',
    egressNetwork,
    '-e',
    `ALLOWED_DOMAINS=${allowedDomains.join(',')}`,
    PROXY_IMAGE,
  ]
}

/** Second leg. The agent container is only on the internal network and
 * resolves `proxyUrl`'s host (the proxy container name) from that
 * network's DNS. */
export function connectProxyToInternalArgs(internalNetwork: string, containerName: string): string[] {
  return ['network', 'connect', internalNetwork, containerName]
}

/** `docker rm` accepts `-f`, `-l`, and `-v` — there is no timeout flag, so
 * `rm -f -t 0` is rejected by Docker. Podman `rm -f` still waits the
 * default 10s because squid ignores SIGTERM. `stop -t 0` is Docker's
 * `--timeout` and Podman's `--time`: SIGTERM, then SIGKILL immediately. */
export function stopProxyArgs(containerName: string): string[] {
  return ['stop', '-t', '0', containerName]
}

export function removeProxyArgs(containerName: string): string[] {
  return ['rm', '-f', containerName]
}

export function proxyLogsReady(stdout: string, stderr: string): boolean {
  return stdout.includes(PROXY_READY_LOG) || stderr.includes(PROXY_READY_LOG)
}

/** `/proc/net/tcp` and `/proc/net/tcp6` rows: local address
 * `HHHHHHHH:PPPP`, state `0A` is TCP_LISTEN. Read from inside the
 * container — on `podman machine` the container IP is not reachable
 * from the host, so a host-side TCP dial to 3128 is not a signal. */
export function proxyTcpListening(procNet: string, port = PROXY_PORT): boolean {
  const suffix = `:${port.toString(16).toUpperCase().padStart(4, '0')}`
  return procNet.split('\n').some((line) => {
    const cols = line.trim().split(/\s+/)
    const local = cols[1]?.toUpperCase()
    return local?.endsWith(suffix) === true && cols[3]?.toUpperCase() === '0A'
  })
}

export async function resolveEgressNetwork(
  env: NodeJS.ProcessEnv = process.env,
  networkExists: (name: string) => Promise<boolean> = dockerNetworkExists,
): Promise<string> {
  const override = env[EGRESS_NETWORK_ENV]?.trim()
  if (override) return override
  if (await networkExists('bridge')) return 'bridge'
  return 'podman'
}

async function execDocker(args: string[]): Promise<CommandOutput> {
  const { stdout, stderr } = await execFileAsync('docker', args, { encoding: 'utf8' })
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
}

async function dockerNetworkExists(name: string): Promise<boolean> {
  try {
    await execDocker(['network', 'inspect', name])
    return true
  } catch {
    return false
  }
}

function defaultRuntime(): SandboxRuntime {
  return {
    exec: execDocker,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env: process.env,
    networkExists: dockerNetworkExists,
  }
}

const TCP_PROBE = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true'

export async function waitForProxyReady(
  containerName: string,
  runtime: Pick<SandboxRuntime, 'exec' | 'sleep' | 'now'> = defaultRuntime(),
  timeoutMs = PROXY_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = runtime.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      const logs = await runtime.exec(['logs', containerName])
      last = `${logs.stdout}${logs.stderr}`
      if (proxyLogsReady(logs.stdout, logs.stderr)) return
    } catch (err) {
      last = (err as Error).message
    }
    try {
      const proc = await runtime.exec(['exec', containerName, 'sh', '-c', TCP_PROBE])
      const text = `${proc.stdout}\n${proc.stderr}`
      if (text.trim()) last = text
      if (proxyTcpListening(text)) return
    } catch (err) {
      if (!last) last = (err as Error).message
    }
    if (runtime.now() >= deadline) {
      const tail = last.trim().slice(-400)
      throw new Error(
        `sandbox proxy "${containerName}" was not ready within ${timeoutMs}ms ` +
          `(no TCP ${PROXY_PORT} listener and no squid "${PROXY_READY_LOG}" log line). ` +
          `Refusing to attach it to the internal network.` +
          (tail ? ` Last output: ${tail}` : ''),
      )
    }
    await runtime.sleep(PROXY_READY_POLL_MS)
  }
}

async function teardownProxy(
  exec: SandboxRuntime['exec'],
  containerName: string,
  networkName: string,
): Promise<void> {
  await exec(stopProxyArgs(containerName)).catch(() => {})
  await exec(removeProxyArgs(containerName)).catch(() => {})
  await exec(removeNetworkArgs(networkName)).catch(() => {})
}

/**
 * One internal network + squid-proxy sidecar per agent-step invocation,
 * torn down when the step finishes — same per-step (not per-run) lifecycle
 * ticket 05 established for `command` steps' sandbox containers. The agent
 * container itself attaches only to `networkName` and reaches the internet
 * exclusively through `proxyUrl`, which the proxy sidecar's `squid.conf`
 * (generated from `ALLOWED_DOMAINS` at its own container start, see
 * `docker/agent-proxy/entrypoint.sh`) restricts to `allowedDomains`.
 *
 * Order is load-bearing on Podman: create the internal network, run the
 * proxy on the egress network, wait until it accepts connections, then
 * `network connect` the internal network. Connecting earlier races the
 * proxy's resolver setup (the Docker CLI against a Podman socket failed
 * that race; a fixed sleep did not).
 */
export async function createAgentSandboxNetwork(
  stepId: string,
  allowedDomains: string[] = DEFAULT_ALLOWED_DOMAINS,
  runtime: SandboxRuntime = defaultRuntime(),
): Promise<AgentSandboxNetwork> {
  const networkName = sandboxNetworkName(stepId)
  const containerName = proxyContainerName(networkName)
  const egressNetwork = await resolveEgressNetwork(runtime.env, runtime.networkExists)

  await runtime.exec(createNetworkArgs(networkName))
  try {
    await runtime.exec(startProxyArgs(egressNetwork, containerName, allowedDomains))
    await waitForProxyReady(containerName, runtime)
    await runtime.exec(connectProxyToInternalArgs(networkName, containerName))
  } catch (err) {
    await teardownProxy(runtime.exec, containerName, networkName)
    throw err
  }

  return {
    networkName,
    proxyUrl: `http://${containerName}:${PROXY_PORT}`,
    async teardown() {
      await teardownProxy(runtime.exec, containerName, networkName)
    },
  }
}
