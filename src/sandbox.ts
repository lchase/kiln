import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { jobBasename } from "./paths.js";
import type { SandboxSettings } from "./schemas.js";

/**
 * Opt-in Docker sandbox for Kiln agent steps.
 *
 * Off unless kiln config sets `sandbox.mode` to `docker` (a per-workflow
 * block can override that). Kiln injects `sandbox: docker` under each
 * agent step. verify, the approve gate, and land stay on the host: yak's
 * command sandbox does not forward `KILN_TEST` or the truncate wrapper,
 * and land commits with the host git identity. Pull requests and
 * `gh pr view` run in the kiln process.
 *
 * @lchase/yak 0.7.1 drops `sandbox`, `image`, and `allowedDomains` while
 * loading workflow YAML, and calls `createAgentSandboxNetwork` with only
 * `api.anthropic.com`. Kiln refuses to launch while that is still true,
 * because the job would run on the host.
 */

export const AGENT_SANDBOX_IMAGE = "yak-agent-sandbox:latest";
export const PROXY_SANDBOX_IMAGE = "yak-agent-sandbox-proxy:latest";
export const CONTAINER_CLI_PATH = "/app/claude-cli";
export const CONTAINER_WORKDIR = "/workspace";

/**
 * Hosts a coding agent needs on a typical Node repo, and nothing wider.
 * `api.anthropic.com` is the model API. The rest are npm and the GitHub
 * hosts a fetch or an install actually dials. Exact hostnames only: the
 * proxy matches `dstdomain` without a leading dot, so a subdomain is not
 * implied.
 */
export const DEFAULT_SANDBOX_DOMAINS = [
  "api.anthropic.com",
  "registry.npmjs.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
] as const;

/** Printed at the start of a tick when sandbox mode is on and a check failed. */
export const SANDBOX_PREFLIGHT_PREFIX = "Sandbox is on, and a sandboxed run cannot start:";

/** Present in a yak build that copies `allowedDomains` off the agent step. */
export const YAK_ALLOWLIST_MARKER = "raw.agent.allowedDomains";

export interface ResolvedSandbox {
  mode: "off" | "docker";
  image?: string;
  allowDomains: readonly string[];
}

export interface SandboxFacts {
  dockerBinary: boolean;
  /** Meaningful only when `dockerBinary` is true. */
  dockerDaemon: boolean;
  /** Image names `docker image inspect` could see. Empty when docker is down. */
  images: readonly string[];
  yakVersion: string;
  /** Text of the installed `@lchase/yak` bundle. */
  yakDist: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Workflow override wins per field. An omitted field inherits the global
 * setting, then the built-in default. `allowDomains`, when set, replaces
 * the list rather than extending it, so a tighter workflow cannot keep a
 * wider global host by accident.
 */
export function resolveSandbox(global: SandboxSettings | undefined, workflow: SandboxSettings | undefined): ResolvedSandbox {
  const mode = workflow?.mode ?? global?.mode ?? "off";
  const image = workflow?.image ?? global?.image;
  const allowDomains = workflow?.allowDomains ?? global?.allowDomains ?? DEFAULT_SANDBOX_DOMAINS;
  return {
    mode,
    allowDomains: [...allowDomains],
    ...(image ? { image } : {}),
  };
}

/** Resolved sandboxes that would actually containerize a packaged or configured workflow. */
export function sandboxTargets(config: Pick<LoadedKilnConfig, "sandbox" | "workflowSandbox">): ResolvedSandbox[] {
  const names = new Set<string>(["feature", "investigation", "fix", ...Object.keys(config.workflowSandbox)]);
  const targets: ResolvedSandbox[] = [];
  for (const name of names) {
    const resolved = resolveSandbox(config.sandbox, config.workflowSandbox[name]);
    if (resolved.mode === "docker") targets.push(resolved);
  }
  return targets;
}

export function sandboxIsEnabled(config: Pick<LoadedKilnConfig, "sandbox" | "workflowSandbox">): boolean {
  return sandboxTargets(config).length > 0;
}

export function requiredSandboxImages(config: Pick<LoadedKilnConfig, "sandbox" | "workflowSandbox">): string[] {
  const targets = sandboxTargets(config);
  if (targets.length === 0) return [];
  const images = new Set<string>([PROXY_SANDBOX_IMAGE]);
  for (const target of targets) images.add(target.image ?? AGENT_SANDBOX_IMAGE);
  return [...images];
}

/**
 * Insert `sandbox: docker` as the first keys of every `agent:` block.
 * Command steps, gates, and comments are left alone. A block that already
 * has `sandbox:` is not edited again.
 */
export function injectAgentSandbox(yaml: string, sandbox: ResolvedSandbox): string {
  if (sandbox.mode !== "docker") return yaml;
  const lines = yaml.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    out.push(line);
    const match = /^(\s*)agent:\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const base = match[1]?.length ?? 0;
    if (blockHasKey(lines, index + 1, base, "sandbox")) continue;
    const child = childIndent(lines, index + 1, base);
    const pad = " ".repeat(child);
    out.push(`${pad}sandbox: docker`);
    if (sandbox.image) out.push(`${pad}image: ${yamlDoubleQuote(sandbox.image)}`);
    out.push(`${pad}allowedDomains:`);
    for (const domain of sandbox.allowDomains) out.push(`${pad}  - ${domain}`);
  }
  return out.join("\n");
}

/**
 * True when this job's rendered workflow sandboxes agents.
 * A job that has not been rendered yet follows the current config.
 */
export function jobIsSandboxed(config: LoadedKilnConfig, jobId: string, workflow: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workflow)) {
    return resolveSandbox(config.sandbox, config.workflowSandbox[workflow]).mode === "docker";
  }
  const dir = join(config.kilnDir, "rendered", jobBasename(jobId));
  const names = workflow === "fix" ? ["fix.yaml"] : [`${workflow}.yaml`, "fix.yaml"];
  let sawRender = false;
  for (const name of names) {
    try {
      const text = readFileSync(join(dir, name), "utf8");
      sawRender = true;
      if (/^\s*sandbox:\s*docker\s*$/m.test(text)) return true;
    } catch {
      // That render is absent.
    }
  }
  if (sawRender) return false;
  return resolveSandbox(config.sandbox, config.workflowSandbox[workflow]).mode === "docker";
}

export function yakDistHonorsAllowlist(distSource: string): boolean {
  return distSource.includes(YAK_ALLOWLIST_MARKER);
}

export function credentialPresent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
}

/**
 * Names every missing piece. Returns undefined when this sandbox can launch.
 * The text never includes an environment value.
 */
export function sandboxPreflightFor(
  sandbox: ResolvedSandbox,
  adapter: LoadedKilnConfig["adapter"],
  facts: SandboxFacts,
): string | undefined {
  if (sandbox.mode !== "docker") return undefined;
  return formatPreflight(missingPieces([sandbox.image ?? AGENT_SANDBOX_IMAGE], adapter, facts));
}

/** Union of every workflow whose resolved mode is docker. */
export function sandboxPreflight(config: LoadedKilnConfig, facts: SandboxFacts): string | undefined {
  const images = requiredSandboxImages(config);
  if (images.length === 0) return undefined;
  const agentImages = images.filter((image) => image !== PROXY_SANDBOX_IMAGE);
  return formatPreflight(missingPieces(agentImages, config.adapter, facts));
}

export function sandboxPreflightMessage(config: LoadedKilnConfig, facts?: SandboxFacts): string | undefined {
  if (!sandboxIsEnabled(config)) return undefined;
  return sandboxPreflight(config, facts ?? probeSandboxEnvironment(process.env, requiredSandboxImages(config)));
}

/**
 * `docker` argv yak 0.7.1 builds for one sandboxed agent step
 * (`dockerAgentRunArgs` in `@lchase/yak`). Kiln does not spawn docker
 * itself. Credential values are copied through so a test can show the
 * shape; do not log the result when `env` holds a real token.
 */
export function agentSandboxDockerArgs(input: {
  image?: string;
  cwd: string;
  networkName: string;
  proxyUrl: string;
  cliArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = input.env ?? {};
  const credentialEnv = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((key) => env[key] !== undefined)
    .flatMap((key) => ["-e", `${key}=${env[key]}`]);
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    input.networkName,
    "-v",
    `${input.cwd}:${CONTAINER_WORKDIR}`,
    "-w",
    CONTAINER_WORKDIR,
    "-e",
    `HTTPS_PROXY=${input.proxyUrl}`,
    "-e",
    `HTTP_PROXY=${input.proxyUrl}`,
    ...credentialEnv,
    input.image ?? AGENT_SANDBOX_IMAGE,
    CONTAINER_CLI_PATH,
    ...input.cliArgs,
  ];
}

/** Proxy sidecar argv from yak's `startProxyArgs`. */
export function proxySandboxDockerArgs(networkName: string, allowedDomains: readonly string[]): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    `${networkName}-proxy`,
    "--network",
    networkName,
    "-e",
    `ALLOWED_DOMAINS=${allowedDomains.join(",")}`,
    PROXY_SANDBOX_IMAGE,
  ];
}

export function sandboxImageBuildArgs(yakVersion: string): string[][] {
  const ref = `yak-v${yakVersion}`;
  const remote = "https://github.com/lchase/yak.git";
  return [
    ["build", "-t", AGENT_SANDBOX_IMAGE, `${remote}#${ref}:docker/agent-sandbox`],
    ["build", "-t", PROXY_SANDBOX_IMAGE, `${remote}#${ref}:docker/agent-proxy`],
  ];
}

/** git is not in yak's node:22-slim agent image. Agents shell out to git. */
export function sandboxGitOverlayDockerfile(): string {
  return [
    "FROM yak-agent-sandbox:latest",
    "USER root",
    "RUN apt-get update \\",
    " && apt-get install -y --no-install-recommends git ca-certificates \\",
    " && rm -rf /var/lib/apt/lists/*",
    "",
  ].join("\n");
}

export function renderSandboxStatus(config: LoadedKilnConfig, facts?: SandboxFacts): string {
  const names = [...new Set(["feature", "investigation", "fix", ...Object.keys(config.workflowSandbox)])].sort();
  const lines = names.map((name) => {
    const resolved = resolveSandbox(config.sandbox, config.workflowSandbox[name]);
    const image = resolved.image ? `  image ${resolved.image}` : "";
    const domains = resolved.mode === "docker" ? `  allow ${resolved.allowDomains.join(" ")}` : "";
    return `${name}  ${resolved.mode}${image}${domains}`;
  });
  const problem = sandboxPreflightMessage(config, facts);
  lines.push(problem ?? (sandboxIsEnabled(config) ? "sandbox ready" : "sandbox off"));
  return `${lines.join("\n")}\n`;
}

export function runSandboxBuild(): void {
  const version = installedYakVersion();
  for (const args of sandboxImageBuildArgs(version)) runDocker(args);
  const dir = mkdtempSync(join(tmpdir(), "kiln-sandbox-"));
  const file = join(dir, "Dockerfile");
  writeFileSync(file, sandboxGitOverlayDockerfile());
  runDocker(["build", "-t", AGENT_SANDBOX_IMAGE, "-f", file, dir]);
}

export function probeSandboxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  images: readonly string[] = [AGENT_SANDBOX_IMAGE, PROXY_SANDBOX_IMAGE],
): SandboxFacts {
  const binary = dockerResult(["--version"]);
  const dockerBinary = binary.status === 0;
  const daemon = dockerBinary ? dockerResult(["info"]) : undefined;
  const present =
    dockerBinary && daemon?.status === 0
      ? images.filter((name) => dockerResult(["image", "inspect", name]).status === 0)
      : [];
  const yak = readInstalledYak();
  return {
    dockerBinary,
    dockerDaemon: daemon?.status === 0,
    images: present,
    yakVersion: yak.version,
    yakDist: yak.dist,
    env,
  };
}

function missingPieces(agentImages: readonly string[], adapter: LoadedKilnConfig["adapter"], facts: SandboxFacts): string[] {
  const missing: string[] = [];
  if (!facts.dockerBinary) {
    missing.push("docker binary is not on PATH");
  } else if (!facts.dockerDaemon) {
    missing.push("docker daemon is not reachable");
  } else {
    if (!facts.images.includes(PROXY_SANDBOX_IMAGE)) {
      missing.push(`image ${PROXY_SANDBOX_IMAGE} is missing (kiln sandbox build)`);
    }
    for (const image of agentImages) {
      if (!facts.images.includes(image)) missing.push(`image ${image} is missing (kiln sandbox build)`);
    }
  }
  if (adapter === "claude-code" && !credentialPresent(facts.env)) {
    missing.push(
      "no Claude credential for the sandbox. The container only receives ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN. macOS keychain login is not forwarded. Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN for this kiln process.",
    );
  }
  if (!yakDistHonorsAllowlist(facts.yakDist)) {
    missing.push(
      `installed @lchase/yak ${facts.yakVersion} does not pass allowedDomains from a workflow step into the sandbox proxy. @lchase/yak 0.7.1 drops sandbox, image, and allowedDomains when it loads workflow YAML, and the proxy allowlist stays api.anthropic.com. Kiln will not launch an unsandboxed run while sandbox mode is docker.`,
    );
  }
  return missing;
}

function formatPreflight(missing: string[]): string | undefined {
  if (missing.length === 0) return undefined;
  return `${SANDBOX_PREFLIGHT_PREFIX}\n${missing.map((line) => `- ${line}`).join("\n")}`;
}

function childIndent(lines: string[], start: number, base: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (indent <= base) break;
    return indent;
  }
  return base + 2;
}

function blockHasKey(lines: string[], start: number, base: number, key: string): boolean {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (indent <= base) return false;
    if (new RegExp(`^\\s*${key}:\\s*`).test(line)) return true;
  }
  return false;
}

function yamlDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function installedYakVersion(): string {
  return readInstalledYak().version;
}

function readInstalledYak(): { version: string; dist: string } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@lchase/yak/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  const version = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  let dist = "";
  try {
    dist = readFileSync(join(dirname(pkgPath), "dist", "index.js"), "utf8");
  } catch {
    dist = "";
  }
  return { version, dist };
}

function dockerResult(args: string[]): { status: number | null } {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: "ignore" });
  return { status: result.error ? null : result.status };
}

function runDocker(args: string[]): void {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("docker binary is not on PATH. Install Docker and run kiln sandbox build again.");
    }
    throw new Error(`docker ${args[0] ?? "build"} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} exited ${result.status ?? "with a signal"}.`);
  }
}
