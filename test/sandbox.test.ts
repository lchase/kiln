import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildAttention } from "../src/attention.js";
import { stageOf } from "../src/board.js";
import { loadKilnConfig } from "../src/config.js";
import { runTick } from "../src/driver.js";
import { KilnConfigError } from "../src/errors.js";
import { writeJob } from "../src/jobs.js";
import { packageRoot } from "../src/paths.js";
import { readStatus } from "../src/driver.js";
import { renderConsole } from "../src/serve-page.js";
import {
  AGENT_SANDBOX_IMAGE,
  agentSandboxDockerArgs,
  CONTAINER_CLI_PATH,
  CONTAINER_WORKDIR,
  DEFAULT_SANDBOX_DOMAINS,
  injectAgentSandbox,
  PROXY_SANDBOX_IMAGE,
  proxySandboxDockerArgs,
  resolveSandbox,
  sandboxGitOverlayDockerfile,
  sandboxImageBuildArgs,
  sandboxPreflight,
  sandboxPreflightFor,
  YAK_ALLOWLIST_MARKER,
  type SandboxFacts,
} from "../src/sandbox.js";
import type { LoadedKilnConfig } from "../src/config.js";
import type { StatusJobView } from "../src/report.js";

const keep: string[] = [];

after(() => {
  for (const dir of keep) rmSync(dir, { recursive: true, force: true });
});

function facts(overrides: Partial<SandboxFacts> = {}): SandboxFacts {
  return {
    dockerBinary: true,
    dockerDaemon: true,
    images: [AGENT_SANDBOX_IMAGE, PROXY_SANDBOX_IMAGE],
    yakVersion: "0.7.1",
    yakDist: `function load(){ return raw.agent.allowedDomains }`,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-value" },
    ...overrides,
  };
}

function configWith(extra: Record<string, unknown>, adapter: "mock" | "claude-code" = "claude-code"): LoadedKilnConfig {
  const dir = mkdtempSync(join(tmpdir(), "kiln-sandbox-"));
  keep.push(dir);
  const checkout = join(dir, "web");
  mkdirSync(checkout);
  const configDir = join(dir, "kiln");
  mkdirSync(configDir);
  const configPath = join(configDir, "kiln.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ adapter, repos: { web: { path: checkout, test: "npm test" } }, ...extra }, null, 2)}\n`,
  );
  return loadKilnConfig(configPath);
}

describe("sandbox config", () => {
  it("is off when the config omits it", () => {
    const config = configWith({});
    assert.equal(resolveSandbox(config.sandbox, undefined).mode, "off");
    assert.deepEqual(resolveSandbox(config.sandbox, undefined).allowDomains, [...DEFAULT_SANDBOX_DOMAINS]);
  });

  it("lets a workflow replace mode, image, and the allowlist", () => {
    const config = configWith({
      sandbox: { mode: "docker", image: "kiln-agent:global", allowDomains: ["api.anthropic.com"] },
      workflows: {
        feature: { sandbox: { mode: "off" } },
        investigation: { sandbox: { image: "kiln-agent:spike", allowDomains: ["api.anthropic.com", "github.com"] } },
      },
    });
    const feature = resolveSandbox(config.sandbox, config.workflowSandbox.feature);
    assert.equal(feature.mode, "off");
    assert.equal(feature.image, "kiln-agent:global");
    assert.deepEqual(feature.allowDomains, ["api.anthropic.com"]);
    const investigation = resolveSandbox(config.sandbox, config.workflowSandbox.investigation);
    assert.equal(investigation.mode, "docker");
    assert.equal(investigation.image, "kiln-agent:spike");
    assert.deepEqual(investigation.allowDomains, ["api.anthropic.com", "github.com"]);
  });

  it("rejects an allowlist entry that is not a hostname", () => {
    assert.throws(
      () => configWith({ sandbox: { mode: "docker", allowDomains: ["https://evil.example/steal"] } }),
      (error: unknown) => error instanceof KilnConfigError && /hostname/.test(error.message),
    );
  });
});

describe("sandbox injection", () => {
  const on = resolveSandbox({ mode: "docker" }, undefined);

  it("adds sandbox docker to every agent step and leaves host steps alone", () => {
    const feature = injectAgentSandbox(readFileSync(join(packageRoot(), "workflows", "feature.yaml"), "utf8"), on);
    const agents = feature.split("\n").filter((line) => /^\s*agent:\s*$/.test(line));
    const marked = feature.split("\n").filter((line) => /^\s*sandbox: docker\s*$/.test(line));
    assert.equal(agents.length, 7);
    assert.equal(marked.length, 7);
    for (const domain of DEFAULT_SANDBOX_DOMAINS) assert.match(feature, new RegExp(`- ${domain}`));
    const verify = feature.slice(feature.indexOf("- id: verify"), feature.indexOf("- id: security"));
    assert.match(verify, /command:/);
    assert.doesNotMatch(verify, /sandbox:/);
    const land = feature.slice(feature.indexOf("- id: land"));
    assert.match(land, /git commit/);
    assert.doesNotMatch(land, /sandbox:/);
    const gate = feature.slice(feature.lastIndexOf("- id: approve"));
    assert.match(gate, /gate:/);
    assert.doesNotMatch(gate, /sandbox:/);

    const investigation = injectAgentSandbox(
      readFileSync(join(packageRoot(), "workflows", "investigation.yaml"), "utf8"),
      on,
    );
    assert.equal(investigation.split("\n").filter((line) => /^\s*sandbox: docker\s*$/.test(line)).length, 1);
    const approve = investigation.slice(investigation.indexOf("- id: approve"));
    assert.match(approve, /gate:/);
    assert.doesNotMatch(approve, /sandbox:/);

    const fix = injectAgentSandbox(readFileSync(join(packageRoot(), "workflows", "fix.yaml"), "utf8"), on);
    assert.equal(fix.split("\n").filter((line) => /^\s*sandbox: docker\s*$/.test(line)).length, 1);
    const fixLand = fix.slice(fix.indexOf("- id: land"));
    assert.match(fixLand, /git commit/);
    assert.doesNotMatch(fixLand, /sandbox:/);
  });

  it("quotes an image override and does not inject twice", () => {
    const once = injectAgentSandbox("steps:\n  - id: spec\n    agent:\n      model: opus\n", {
      mode: "docker",
      image: "ghcr.io/example/agent:1",
      allowDomains: ["api.anthropic.com"],
    });
    assert.match(once, /image: "ghcr.io\/example\/agent:1"/);
    assert.equal(injectAgentSandbox(once, on), once);
  });

  it("is a no-op while mode is off", () => {
    const yaml = "  - id: spec\n    agent:\n      model: opus\n";
    assert.equal(injectAgentSandbox(yaml, resolveSandbox(undefined, undefined)), yaml);
  });
});

describe("sandbox preflight", () => {
  it("names each missing piece and never prints a credential value", () => {
    const config = configWith({ sandbox: { mode: "docker" } });
    const missingDocker = sandboxPreflight(config, facts({ dockerBinary: false, env: { NOT_A_TOKEN: "hunter2" } }));
    assert.match(missingDocker ?? "", /docker binary is not on PATH/);
    assert.doesNotMatch(missingDocker ?? "", /image /);
    assert.doesNotMatch(missingDocker ?? "", /hunter2/);
    assert.doesNotMatch(missingDocker ?? "", /fixture-oauth-value/);

    const missingDaemon = sandboxPreflight(config, facts({ dockerDaemon: false, images: [] }));
    assert.match(missingDaemon ?? "", /docker daemon is not reachable/);
    assert.doesNotMatch(missingDaemon ?? "", /image /);

    const missingImages = sandboxPreflight(
      config,
      facts({ images: [], env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-value" } }),
    );
    assert.match(missingImages ?? "", new RegExp(`image ${AGENT_SANDBOX_IMAGE} is missing`));
    assert.match(missingImages ?? "", new RegExp(`image ${PROXY_SANDBOX_IMAGE} is missing`));
    assert.doesNotMatch(missingImages ?? "", /fixture-oauth-value/);
    assert.doesNotMatch(missingImages ?? "", /claude setup-token/);

    const missingToken = sandboxPreflight(
      config,
      facts({ env: { NOT_A_TOKEN: "hunter2" }, yakDist: `ok ${YAK_ALLOWLIST_MARKER}` }),
    );
    assert.match(missingToken ?? "", /claude setup-token/);
    assert.match(missingToken ?? "", /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(missingToken ?? "", /hunter2/);
    assert.doesNotMatch(missingToken ?? "", /docker binary/);

    const oldYak = sandboxPreflight(config, facts({ yakDist: "createAgentSandboxNetwork(stepId)", env: {} }));
    assert.match(oldYak ?? "", /does not pass allowedDomains/);
    assert.match(oldYak ?? "", /0\.7\.1/);

    assert.equal(sandboxPreflight(config, facts()), undefined);
    assert.equal(sandboxPreflight(configWith({}), facts({ dockerBinary: false, env: {} })), undefined);
  });

  it("skips the token check for the mock adapter", () => {
    const config = configWith({ sandbox: { mode: "docker" } }, "mock");
    assert.equal(sandboxPreflight(config, facts({ env: {} })), undefined);
  });

  it("names a custom image", () => {
    const config = configWith({ sandbox: { mode: "docker", image: "example.com/agent:1" } });
    const text = sandboxPreflightFor(
      resolveSandbox(config.sandbox, undefined),
      "mock",
      facts({ images: [PROXY_SANDBOX_IMAGE] }),
    );
    assert.match(text ?? "", /image example.com\/agent:1 is missing/);
    assert.doesNotMatch(text ?? "", new RegExp(`image ${AGENT_SANDBOX_IMAGE} is missing`));
  });
});

describe("sandbox docker argv", () => {
  it("matches yak's agent and proxy invocation", () => {
    const network = "yak-agent-spec-abc123";
    const proxy = proxySandboxDockerArgs(network, [...DEFAULT_SANDBOX_DOMAINS]);
    assert.deepEqual(proxy, [
      "run",
      "-d",
      "--rm",
      "--name",
      `${network}-proxy`,
      "--network",
      network,
      "-e",
      `ALLOWED_DOMAINS=${DEFAULT_SANDBOX_DOMAINS.join(",")}`,
      PROXY_SANDBOX_IMAGE,
    ]);
    const agent = agentSandboxDockerArgs({
      cwd: "/work/repo",
      networkName: network,
      proxyUrl: `http://${network}-proxy:3128`,
      cliArgs: ["--print", "hello"],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-value" },
    });
    assert.deepEqual(agent, [
      "run",
      "--rm",
      "-i",
      "--network",
      network,
      "-v",
      `/work/repo:${CONTAINER_WORKDIR}`,
      "-w",
      CONTAINER_WORKDIR,
      "-e",
      `HTTPS_PROXY=http://${network}-proxy:3128`,
      "-e",
      `HTTP_PROXY=http://${network}-proxy:3128`,
      "-e",
      "CLAUDE_CODE_OAUTH_TOKEN=fixture-oauth-value",
      AGENT_SANDBOX_IMAGE,
      CONTAINER_CLI_PATH,
      "--print",
      "hello",
    ]);
    assert.deepEqual(sandboxImageBuildArgs("0.7.1"), [
      ["build", "-t", AGENT_SANDBOX_IMAGE, "https://github.com/lchase/yak.git#yak-v0.7.1:docker/agent-sandbox"],
      ["build", "-t", PROXY_SANDBOX_IMAGE, "https://github.com/lchase/yak.git#yak-v0.7.1:docker/agent-proxy"],
    ]);
    assert.match(sandboxGitOverlayDockerfile(), /FROM yak-agent-sandbox:latest/);
    assert.match(sandboxGitOverlayDockerfile(), /apt-get install -y --no-install-recommends git ca-certificates/);
  });
});

describe("sandbox launch and board", () => {
  it("refuses to launch when preflight fails and marks the card", () => {
    const config = configWith({ sandbox: { mode: "docker" } });
    const written = writeJob(config, {
      workflow: "feature",
      repo: "web",
      specText: "# Sandbox the agent\n\nDo the work.\n",
      title: "Sandbox the agent",
      dependsOn: [],
      source: { kind: "prompt", ref: "inline" },
    });
    const output = runTick(config, undefined, {
      startup: false,
      now: new Date("2026-05-01T00:00:00.000Z"),
      sandboxFacts: facts({
        dockerBinary: false,
        dockerDaemon: false,
        images: [],
        yakDist: "no allowlist",
        env: { NOT_A_TOKEN: "hunter2" },
      }),
    });
    assert.match(output, /docker binary is not on PATH/);
    assert.match(output, /claude setup-token/);
    assert.match(output, /does not pass allowedDomains/);
    assert.doesNotMatch(output, /hunter2/);
    assert.doesNotMatch(output, /fixture-oauth-value/);
    assert.doesNotMatch(output, /pid /);
    const status = readStatus(config, written.job.id);
    const job = status.jobs[0];
    assert.equal(job?.state, "failed");
    assert.equal(job?.sandboxed, true);
    assert.match(job?.launchError ?? "", /docker binary is not on PATH/);
    const rendered = readFileSync(join(config.kilnDir, "rendered", written.job.id, "feature.yaml"), "utf8");
    assert.match(rendered, /sandbox: docker/);
    assert.doesNotMatch(rendered.slice(rendered.indexOf("- id: land")), /sandbox:/);
    const view = job as StatusJobView;
    assert.equal(stageOf(view), "needs-human");
    const html = renderConsole("", buildAttention([view]));
    assert.match(html, /sandbox · docker/);
    const reason = status.attention.needsYou.find((item) => item.job.jobId === written.job.id)?.reason ?? "";
    assert.match(reason, /docker binary is not on PATH/);
  });
});
