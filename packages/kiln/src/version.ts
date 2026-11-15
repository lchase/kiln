import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "./paths.js";

/**
 * Versions printed by `kiln --version` and by `kiln serve`.
 *
 * Kiln's version is the `package.json` next to the running file
 * (`packageRoot()`), not the working directory. Yak's version is the
 * `@lchase/yak` package Node resolves from that same file via
 * `require.resolve`. A package that cannot be resolved, or that has no
 * version string, is `unknown`.
 */
export interface RuntimeVersions {
  kiln: string;
  yak: string;
}

export interface OverlayStartupCounts {
  workflows: number;
  promptOverrides: number;
  skillDirs: number;
}

export interface ServeStartup {
  /** Defaults to {@link runtimeVersions}. Pass a value in tests. */
  versions?: RuntimeVersions;
  /** `process.version`, including the leading `v`. */
  node: string;
  /** Kiln home: the directory of `--config`, `$KILN_HOME`, or `~/.kiln`. */
  home: string;
  /** Bound board URL, for example `http://127.0.0.1:4100`. */
  url: string;
  /** Omit when `--no-tick` leaves the factory where it is. */
  tickSeconds?: number;
  paused: boolean;
  sandbox: "off" | "docker";
  /**
   * Local overlay counts. Omit on a build that has no overlay.
   * Zero counts are still printed: the line says the feature is present
   * and nothing local was loaded.
   */
  overlay?: OverlayStartupCounts;
}

type PackageResolve = (specifier: string) => string;

function defaultPackageResolve(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

/** Version string from a `package.json`. Missing or empty is `unknown`. */
export function packageVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
}

/**
 * Kiln and yak versions for this process.
 * `resolveYak` is the `@lchase/yak/package.json` resolver. Tests pass one
 * that fails; serve and `--version` use the default.
 */
export function runtimeVersions(options: { resolveYak?: PackageResolve } = {}): RuntimeVersions {
  const resolve = options.resolveYak ?? defaultPackageResolve;
  return {
    kiln: packageVersion(join(packageRoot(), "package.json")),
    yak: yakVersion(resolve),
  };
}

function yakVersion(resolve: PackageResolve): string {
  try {
    return packageVersion(resolve("@lchase/yak/package.json"));
  } catch {
    return "unknown";
  }
}

/** Two lines. `kiln serve` prints this same text at the top of its startup block. */
export function formatVersionReport(versions: RuntimeVersions = runtimeVersions()): string {
  return `kiln ${versions.kiln}\nyak ${versions.yak}\n`;
}

/** Startup block for `kiln serve`. Replaces the old one-line `listening` log. */
export function formatServeStartup(info: ServeStartup): string {
  const lines = [
    ...formatVersionReport(info.versions ?? runtimeVersions()).trimEnd().split("\n"),
    `node ${info.node}`,
    `home ${info.home}`,
    `listening ${info.url}`,
    tickState(info),
  ];
  if (info.overlay) lines.push(overlayLine(info.overlay));
  return `${lines.join("\n")}\n`;
}

function tickState(info: ServeStartup): string {
  const tick = info.tickSeconds === undefined ? "tick off" : `tick every ${info.tickSeconds}s`;
  const factory = info.paused ? "paused" : "running";
  return `${tick}, ${factory}, sandbox ${info.sandbox}`;
}

function overlayLine(overlay: OverlayStartupCounts): string {
  const workflows = counted(overlay.workflows, "workflow", "workflows");
  const prompts = counted(overlay.promptOverrides, "prompt override", "prompt overrides");
  const skills = counted(overlay.skillDirs, "skill dir", "skill dirs");
  return `local ${workflows}, ${prompts}, ${skills}`;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
