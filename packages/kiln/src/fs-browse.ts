import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { HttpError } from "./errors.js";

/** A chosen markdown file returns this many lines, and no more of the body. */
export const PREVIEW_LINES = 40;
const PREVIEW_BYTES = 16 * 1024;

export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export interface FsListing {
  path: string;
  parent: string | null;
  kind: "dir";
  entries: FsEntry[];
}

export interface FsPreview {
  path: string;
  kind: "file";
  preview: string;
  truncated: boolean;
}

export function homeReal(home = homedir()): string {
  try {
    return realpathSync(resolve(home));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(500, `Home directory is not available: ${message}`);
  }
}

/**
 * Absolute path of `target` after symlink resolution.
 * Refuses anything outside `home`, and any hidden path segment.
 */
export function assertInsideHome(home: string, target: string): string {
  const root = homeReal(home);
  const resolved = resolve(target);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new HttpError(404, `No such path ${resolved}.`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new HttpError(403, "Path is outside the home directory.");
  }
  const rel = relative(root, real);
  if (rel !== "" && rel.split(sep).some((part) => part.startsWith("."))) {
    throw new HttpError(403, "Hidden files are not listed.");
  }
  return real;
}

/** Directories and `.md` files under the home directory. A file returns a short preview. */
export function browse(home: string, rawPath: string | undefined): FsListing | FsPreview {
  const root = homeReal(home);
  const requested = rawPath?.trim() ? rawPath : root;
  const real = assertInsideHome(home, requested);
  const stat = statSync(real);
  if (stat.isDirectory()) return listDir(root, real);
  if (stat.isFile()) return previewFile(real);
  throw new HttpError(400, "Only directories and .md files can be opened.");
}

function listDir(root: string, dir: string): FsListing {
  const names = readdirSync(dir);
  const entries: FsEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    let real: string;
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (real !== root && !real.startsWith(root + sep)) continue;
    const rel = relative(root, real);
    if (rel !== "" && rel.split(sep).some((part) => part.startsWith("."))) continue;
    if (info.isDirectory()) entries.push({ name, path: real, kind: "dir" });
    else if (info.isFile() && name.toLowerCase().endsWith(".md")) entries.push({ name, path: real, kind: "file" });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return { path: dir, parent: parentInside(root, dir), kind: "dir", entries };
}

function parentInside(root: string, dir: string): string | null {
  if (dir === root) return null;
  const parent = dirname(dir);
  if (parent !== root && !parent.startsWith(root + sep)) return null;
  return parent;
}

function previewFile(path: string): FsPreview {
  if (!basename(path).toLowerCase().endsWith(".md")) {
    throw new HttpError(400, "Only .md files can be previewed.");
  }
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(PREVIEW_BYTES);
    const read = readSync(fd, buf, 0, PREVIEW_BYTES, 0);
    const lines = buf.subarray(0, read).toString("utf8").split(/\r?\n/);
    return {
      path,
      kind: "file",
      preview: lines.slice(0, PREVIEW_LINES).join("\n"),
      truncated: lines.length > PREVIEW_LINES || size > read,
    };
  } finally {
    closeSync(fd);
  }
}
