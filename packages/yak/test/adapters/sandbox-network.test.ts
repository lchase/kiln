import { describe, expect, it } from 'vitest'
import {
  connectProxyToInternalArgs,
  createAgentSandboxNetwork,
  createNetworkArgs,
  DEFAULT_ALLOWED_DOMAINS,
  EGRESS_NETWORK_ENV,
  PROXY_READY_LOG,
  PROXY_READY_POLL_MS,
  PROXY_READY_TIMEOUT_MS,
  proxyContainerName,
  proxyLogsReady,
  proxyTcpListening,
  removeNetworkArgs,
  removeProxyArgs,
  resolveEgressNetwork,
  sandboxNetworkName,
  startProxyArgs,
  stopProxyArgs,
  waitForProxyReady,
  type SandboxRuntime,
} from '../../src/adapters/sandbox-network.js'

describe('sandboxNetworkName', () => {
  it('sanitizes characters outside [a-zA-Z0-9_.-] from the step id', () => {
    const name = sandboxNetworkName('my step/id!')
    expect(name).toMatch(/^yak-agent-my-step-id--[0-9a-f]{8}$/)
  })

  it('produces a different name on each call (per-invocation, not per-step)', () => {
    expect(sandboxNetworkName('a')).not.toBe(sandboxNetworkName('a'))
  })
})

describe('proxyContainerName', () => {
  it('derives the proxy container name from the network name', () => {
    expect(proxyContainerName('yak-agent-a-1234abcd')).toBe('yak-agent-a-1234abcd-proxy')
  })
})

describe('docker argv builders', () => {
  it('createNetworkArgs builds an --internal network', () => {
    expect(createNetworkArgs('net1')).toEqual(['network', 'create', '--internal', 'net1'])
  })

  it('removeNetworkArgs removes the network', () => {
    expect(removeNetworkArgs('net1')).toEqual(['network', 'rm', 'net1'])
  })

  it('startProxyArgs attaches the proxy to the egress network with an ALLOWED_DOMAINS env var', () => {
    expect(startProxyArgs('podman', 'net1-proxy', ['api.anthropic.com'])).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'net1-proxy',
      '--network',
      'podman',
      '-e',
      'ALLOWED_DOMAINS=api.anthropic.com',
      'yak-agent-sandbox-proxy:latest',
    ])
  })

  it('startProxyArgs joins multiple allowed domains with commas', () => {
    const args = startProxyArgs('bridge', 'net1-proxy', ['api.anthropic.com', 'example.com'])
    expect(args).toContain('ALLOWED_DOMAINS=api.anthropic.com,example.com')
    expect(args).toContain('bridge')
  })

  it('connectProxyToInternalArgs attaches the internal network after the proxy is up', () => {
    expect(connectProxyToInternalArgs('yak-agent-code-abcd', 'yak-agent-code-abcd-proxy')).toEqual([
      'network',
      'connect',
      'yak-agent-code-abcd',
      'yak-agent-code-abcd-proxy',
    ])
  })

  it('stopProxyArgs kills with no grace period, and rm -f has no -t (Docker rejects it)', () => {
    expect(stopProxyArgs('net1-proxy')).toEqual(['stop', '-t', '0', 'net1-proxy'])
    expect(removeProxyArgs('net1-proxy')).toEqual(['rm', '-f', 'net1-proxy'])
    expect(removeProxyArgs('net1-proxy')).not.toContain('-t')
  })
})

describe('proxy readiness signals', () => {
  it('treats squid\'s Accepting HTTP line on either stream as ready', () => {
    expect(proxyLogsReady('', `2026/01/01| ${PROXY_READY_LOG} Socket connections at local=[::]:3128`)).toBe(true)
    expect(proxyLogsReady(`${PROXY_READY_LOG} Socket connections`, '')).toBe(true)
    expect(proxyLogsReady('FATAL: Unable to open HTTP Socket', '')).toBe(false)
  })

  it('sees TCP 3128 only when /proc/net/tcp reports LISTEN', () => {
    const listen = '  0: 00000000:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 0 1'
    const established = '  1: 0100007F:0C38 0100007F:0050 01 00000000:00000000 00:00000000 00000000 0 0 0 1'
    const otherPort = '  0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 0 1'
    const v6 = '  0: 00000000000000000000000000000000:0C38 00000000000000000000000000000000:0000 0A 00 0 0 0 0'
    expect(proxyTcpListening(listen)).toBe(true)
    expect(proxyTcpListening(v6)).toBe(true)
    expect(proxyTcpListening(established)).toBe(false)
    expect(proxyTcpListening(otherPort)).toBe(false)
    expect(proxyTcpListening('')).toBe(false)
  })
})

describe('resolveEgressNetwork', () => {
  it('uses YAK_SANDBOX_EGRESS_NETWORK without inspecting when it is set', async () => {
    let inspected = false
    const name = await resolveEgressNetwork({ [EGRESS_NETWORK_ENV]: '  custom ' }, async () => {
      inspected = true
      return true
    })
    expect(name).toBe('custom')
    expect(inspected).toBe(false)
  })

  it('uses bridge when docker network inspect bridge succeeds', async () => {
    const name = await resolveEgressNetwork({}, async (network) => network === 'bridge')
    expect(name).toBe('bridge')
  })

  it('falls back to podman when bridge is absent', async () => {
    const name = await resolveEgressNetwork({}, async () => false)
    expect(name).toBe('podman')
  })

  it('ignores a blank override and still inspects', async () => {
    const name = await resolveEgressNetwork({ [EGRESS_NETWORK_ENV]: '   ' }, async () => false)
    expect(name).toBe('podman')
  })
})

function fakeRuntime(opts: {
  env?: NodeJS.ProcessEnv
  logs?: () => { stdout: string; stderr: string }
  proc?: () => { stdout: string; stderr: string }
  networkExists?: (name: string) => Promise<boolean>
  onSleep?: () => void
}): { runtime: SandboxRuntime; calls: string[][] } {
  const calls: string[][] = []
  let now = 0
  const runtime: SandboxRuntime = {
    env: opts.env ?? { [EGRESS_NETWORK_ENV]: 'podman' },
    async exec(args) {
      calls.push(args)
      if (args[0] === 'logs') return opts.logs?.() ?? { stdout: '', stderr: `${PROXY_READY_LOG} Socket connections` }
      if (args[0] === 'exec') return opts.proc?.() ?? { stdout: '', stderr: '' }
      return { stdout: '', stderr: '' }
    },
    async sleep() {
      opts.onSleep?.()
      now += PROXY_READY_POLL_MS
    },
    now: () => now,
    async networkExists(name) {
      if (opts.networkExists) return opts.networkExists(name)
      throw new Error(`network inspect should not run when ${EGRESS_NETWORK_ENV} is set`)
    },
  }
  return { runtime, calls }
}

describe('createAgentSandboxNetwork argv order', () => {
  it('runs the proxy on the egress network, waits until it is ready, then connects the internal network', async () => {
    const { runtime, calls } = fakeRuntime({
      env: { [EGRESS_NETWORK_ENV]: 'podman' },
      logs: () => ({ stdout: '', stderr: `${PROXY_READY_LOG} Socket connections at local=[::]:3128` }),
    })
    const network = await createAgentSandboxNetwork('code', ['example.com', 'api.anthropic.com'], runtime)

    const networkName = calls[0]?.[3]
    expect(calls.map((args) => args[0])).toEqual(['network', 'run', 'logs', 'network'])
    expect(calls[0]).toEqual(['network', 'create', '--internal', networkName])
    expect(calls[1]).toEqual(startProxyArgs('podman', `${networkName}-proxy`, ['example.com', 'api.anthropic.com']))
    expect(calls[2]).toEqual(['logs', `${networkName}-proxy`])
    expect(calls[3]).toEqual(connectProxyToInternalArgs(networkName!, `${networkName}-proxy`))
    expect(network.proxyUrl).toBe(`http://${networkName}-proxy:3128`)
    expect(network.networkName).toBe(networkName)

    await network.teardown()
    expect(calls.slice(4)).toEqual([
      stopProxyArgs(`${networkName}-proxy`),
      removeProxyArgs(`${networkName}-proxy`),
      removeNetworkArgs(networkName!),
    ])
  })

  it('omitted allowedDomains keeps the Anthropic-only default on the proxy', async () => {
    const { runtime, calls } = fakeRuntime({})
    const network = await createAgentSandboxNetwork('code', undefined, runtime)
    await network.teardown()
    expect(calls[1]).toContain(`ALLOWED_DOMAINS=${DEFAULT_ALLOWED_DOMAINS.join(',')}`)
  })

  it('accepts a TCP 3128 listener when the Accepting HTTP line has not appeared yet', async () => {
    const { runtime, calls } = fakeRuntime({
      logs: () => ({ stdout: '', stderr: '' }),
      proc: () => ({
        stdout: '  0: 00000000:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 0 1\n',
        stderr: '',
      }),
    })
    const network = await createAgentSandboxNetwork('code', ['example.com'], runtime)
    await network.teardown()
    expect(calls[2]?.[0]).toBe('logs')
    expect(calls[3]?.[0]).toBe('exec')
    expect(calls[4]).toEqual(connectProxyToInternalArgs(calls[0]![3]!, `${calls[0]![3]}-proxy`))
  })

  it('does not attach the internal network when the proxy never becomes ready, and says why', async () => {
    const { runtime, calls } = fakeRuntime({
      logs: () => ({ stdout: '', stderr: 'FATAL: squid failed' }),
      proc: () => ({ stdout: '', stderr: '' }),
      onSleep: () => {},
    })
    let now = 0
    runtime.now = () => now
    runtime.sleep = async () => {
      now += PROXY_READY_TIMEOUT_MS
    }
    await expect(createAgentSandboxNetwork('code', ['example.com'], runtime)).rejects.toThrow(
      /not ready within 15000ms.*no TCP 3128 listener and no squid "Accepting HTTP" log line.*FATAL: squid failed/s,
    )
    expect(calls.some((args) => args[0] === 'network' && args[1] === 'connect')).toBe(false)
    const networkName = calls[0]?.[3]
    expect(calls.slice(-3)).toEqual([
      stopProxyArgs(`${networkName}-proxy`),
      removeProxyArgs(`${networkName}-proxy`),
      removeNetworkArgs(networkName!),
    ])
  })

  it('waitForProxyReady times out with a clear error when neither signal arrives', async () => {
    let now = 0
    await expect(
      waitForProxyReady(
        'proxy',
        {
          async exec(args) {
            if (args[0] === 'logs') return { stdout: '', stderr: '' }
            return { stdout: '', stderr: '' }
          },
          async sleep() {
            now += PROXY_READY_TIMEOUT_MS
          },
          now: () => now,
        },
        15000,
      ),
    ).rejects.toThrow(/sandbox proxy "proxy" was not ready within 15000ms/)
  })
})

describe('DEFAULT_ALLOWED_DOMAINS', () => {
  it('allows only the Anthropic API by default', () => {
    expect(DEFAULT_ALLOWED_DOMAINS).toEqual(['api.anthropic.com'])
  })
})
