import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cachedGitHub, type GitHubHost, type PullRequestViewCache } from "../src/host.js";

type View = ReturnType<GitHubHost["view"]>;

function fakeGitHub(answers: (View | Error)[]): { github: GitHubHost; calls: () => number } {
  let calls = 0;
  const github: GitHubHost = {
    findByHead: () => null,
    createDraft: () => {
      throw new Error("not used");
    },
    view() {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("no answer");
      return answer;
    },
  };
  return { github, calls: () => calls };
}

const open: View = { state: "OPEN", mergedAt: null };
const merged: View = { state: "MERGED", mergedAt: "2026-11-26T21:00:00Z" };

describe("pull request view cache", () => {
  it("answers page reads from the cache until the entry is older than the ttl", () => {
    const { github, calls } = fakeGitHub([open, merged]);
    const cache: PullRequestViewCache = new Map();
    let clock = 1_000;
    const page = cachedGitHub(github, { cache, mode: "read", ttlMs: 100, now: () => clock });

    assert.deepEqual(page.view("/repo", 7), open);
    for (let index = 0; index < 20; index += 1) assert.deepEqual(page.view("/repo", 7), open);
    assert.equal(calls(), 1);

    clock += 100;
    assert.deepEqual(page.view("/repo", 7), merged);
    assert.equal(calls(), 2);
  });

  it("lets the tick refresh every time, and pages see what the tick read", () => {
    const { github, calls } = fakeGitHub([open, open, merged]);
    const cache: PullRequestViewCache = new Map();
    const clock = 1_000;
    const tick = cachedGitHub(github, { cache, mode: "refresh", ttlMs: 100, now: () => clock });
    const page = cachedGitHub(github, { cache, mode: "read", ttlMs: 100, now: () => clock });

    assert.deepEqual(tick.view("/repo", 7), open);
    assert.deepEqual(tick.view("/repo", 7), open);
    assert.equal(calls(), 2);
    assert.deepEqual(tick.view("/repo", 7), merged);
    assert.deepEqual(page.view("/repo", 7), merged);
    assert.equal(calls(), 3);
  });

  it("never asks again about a merged pull request", () => {
    const { github, calls } = fakeGitHub([merged, open]);
    const cache: PullRequestViewCache = new Map();
    let clock = 1_000;
    const tick = cachedGitHub(github, { cache, mode: "refresh", ttlMs: 100, now: () => clock });
    const page = cachedGitHub(github, { cache, mode: "read", ttlMs: 100, now: () => clock });

    assert.deepEqual(page.view("/repo", 7), merged);
    clock += 10_000;
    assert.deepEqual(page.view("/repo", 7), merged);
    assert.deepEqual(tick.view("/repo", 7), merged);
    assert.equal(calls(), 1);
  });

  it("keeps a failure for the ttl on page reads, and keys by checkout and number", () => {
    const failure = new Error("gh is not logged in");
    const { github, calls } = fakeGitHub([failure, open]);
    const cache: PullRequestViewCache = new Map();
    let clock = 1_000;
    const page = cachedGitHub(github, { cache, mode: "read", ttlMs: 100, now: () => clock });

    assert.throws(() => page.view("/repo", 7), /not logged in/);
    assert.throws(() => page.view("/repo", 7), /not logged in/);
    assert.equal(calls(), 1);
    assert.deepEqual(page.view("/repo", 8), open);
    assert.deepEqual(page.view("/other", 7), open);
    assert.equal(calls(), 3);
    clock += 100;
    assert.deepEqual(page.view("/repo", 7), open);
  });
});
