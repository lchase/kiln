// Patches @lchase/yak's mock adapter, which otherwise discards the prompt.
// KILN_PROMPT_LOG is a directory. Each call appends one JSON line:
// { stepId, callIndex, prompt }.

const NEEDLE = "async run(_req) {";

export async function load(url, context, nextLoad) {
  if (typeof url !== "string" || !url.includes("/@lchase/yak/dist/index.js")) {
    return nextLoad(url, context);
  }
  const loaded = await nextLoad(url, context);
  const source = loaded.source?.toString() ?? "";
  if (!source.includes(NEEDLE)) {
    throw new Error("yak mock adapter no longer contains the prompt-recorder needle");
  }
  const patched = source.replace(
    NEEDLE,
    `async run(_req) {
      if (process.env.KILN_PROMPT_LOG) {
        const { appendFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        appendFileSync(
          join(process.env.KILN_PROMPT_LOG, "prompts.jsonl"),
          JSON.stringify({ stepId: this.stepId, callIndex: this.callIndex, prompt: _req.prompt }) + "\\n",
        );
      }
      if (process.env.KILN_MOCK_DELAY_MS && ["security", "ux", "ui", "code"].includes(this.stepId)) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.KILN_MOCK_DELAY_MS)));
      }`,
  );
  return { ...loaded, format: "module", source: patched, shortCircuit: true };
}
