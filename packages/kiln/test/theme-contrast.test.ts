import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { packageRoot } from "../src/paths.js";

const css = readFileSync(join(packageRoot(), "assets", "serve.css"), "utf8");

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((at) => channel(Number.parseInt(h.slice(at, at + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("theme text contrast", () => {
  it("keeps muted, faint, and code text at 4.5:1 on the page, panel, and card in every theme", () => {
    const blocks = [...css.matchAll(/\/\* theme:([a-z0-9-]+) \*\/([\s\S]*?)\/\* theme:end \*\//g)];
    assert.ok(blocks.length > 0);
    const failures: string[] = [];
    for (const [, id, body] of blocks) {
      const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(body ?? "")?.[1];
      for (const text of ["muted", "faint", "code"]) {
        for (const surface of ["bg", "panel", "card"]) {
          const fg = token(text);
          const bg = token(surface);
          if (fg && bg && ratio(fg, bg) < 4.5) failures.push(`${id}: ${text} on ${surface} is ${ratio(fg, bg).toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });
});
