import type { LoadedKilnConfig } from "./config.js";
import { runTick } from "./driver.js";
import { cachedGitHub, productionHost, type PullRequestViewCache, type PullRequestViewEntry } from "./host.js";

/**
 * One tick for `kiln serve`, in its own process. A tick runs `gh` and `git`
 * synchronously for seconds at a time, and inside the server that held every
 * page request until it finished. The server sends the config it is using
 * and gets back the tick report and the pull request states the tick read.
 */
export interface TickRequest {
  config: LoadedKilnConfig;
  triggerStartup: boolean;
}

export interface TickReply {
  report?: string;
  error?: string;
  views: [string, PullRequestViewEntry][];
}

process.once("message", (request: TickRequest) => {
  const cache: PullRequestViewCache = new Map();
  const reply: TickReply = { views: [] };
  try {
    const host = productionHost();
    reply.report = runTick(
      request.config,
      { ...host, github: cachedGitHub(host.github, { cache, mode: "refresh" }) },
      { startup: false, triggerStartup: request.triggerStartup },
    );
  } catch (error) {
    reply.error = error instanceof Error ? error.message : String(error);
  }
  reply.views = [...cache];
  process.send?.(reply, () => process.disconnect());
});
