import { register } from "node:module";

// Test-only. Loaded via NODE_OPTIONS=--import so the yak process yak spawns
// records the prompt the mock adapter actually received.
register("./record-mock-prompts.mjs", import.meta.url);
