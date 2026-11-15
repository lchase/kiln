import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "./paths.js";
import type { OverlayLoadCounts } from "./workflow.js";

export interface RuntimeVersions {
  kiln: string;
  yak: string;
}

export interface ServeStartup {
  versions?: RuntimeVersions;
  node: string;
  home: string;
  url: string;
  tickSeconds?: number;
  paused: boolean;
  sandbox: "off" | "docker";
  /**
   * Omit when this build has no local overlay.
   * A present object still prints the line when every count is zero.
   */
  overlay?: OverlayLoadCounts;
}

type PackageResolve = (specifier: string) => string;

function defaultPackageResolve(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

export function packageVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
}

/**
 * Kiln's version is the `package.json` next to this file (`packageRoot()`),
 * not the working directory. Yak is the `@lchase/yak` package Node resolves
 * from here. A package that cannot be resolved, or that has no version
 * string, is `unknown`.
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

/** Shared by `kiln --version` and the first lines of `kiln serve`. */
export function formatVersionReport(versions: RuntimeVersions = runtimeVersions()): string {
  return `kiln ${versions.kiln}\nyak ${versions.yak}\n`;
}

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

function overlayLine(overlay: OverlayLoadCounts): string {
  const workflows = counted(overlay.workflows, "workflow", "workflows");
  const prompts = counted(overlay.promptOverrides, "prompt override", "prompt overrides");
  const skills = counted(overlay.skillDirs, "skill dir", "skill dirs");
  return `local ${workflows}, ${prompts}, ${skills}`;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
