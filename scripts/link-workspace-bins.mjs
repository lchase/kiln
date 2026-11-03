// npm workspaces hoist dependency bins to the root node_modules/.bin.
// Yak's tests spawn packages/yak/node_modules/.bin/tsx, which a standalone
// install creates and a workspace install does not. Point each workspace
// .bin at the hoisted one.
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join("..", "..", "..", "node_modules", ".bin");

for (const name of readdirSync(join(root, "packages"))) {
  if (!existsSync(join(root, "packages", name, "package.json"))) continue;
  const dir = join(root, "packages", name, "node_modules");
  const bin = join(dir, ".bin");
  mkdirSync(dir, { recursive: true });
  if (existsSync(bin)) continue;
  symlinkSync(target, bin);
}
