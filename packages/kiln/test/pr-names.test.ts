import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseRemoteBranch,
  defaultRemoteBranch,
  pullRequestTitle,
  shortJobId,
  titleSlug,
} from "../src/pr-names.js";

const jobId = "j20261025020600ab12";

describe("pull request names", () => {
  it("leaves a title unchanged when there is no issue, even with a template", () => {
    assert.equal(pullRequestTitle({ title: "Show the weekly summary" }), "Show the weekly summary");
    assert.equal(
      pullRequestTitle({ title: "Show the weekly summary", template: "{issue}: {title}" }),
      "Show the weekly summary",
    );
    assert.equal(pullRequestTitle({ title: "  Show the weekly summary  " }), "Show the weekly summary");
  });

  it("uses [ABC-123] Title and strips a leading key so a Jira summary is not doubled", () => {
    assert.equal(
      pullRequestTitle({ title: "Show the weekly summary", issue: "ABC-123" }),
      "[ABC-123] Show the weekly summary",
    );
    assert.equal(
      pullRequestTitle({ title: "ABC-123: Show the weekly summary", issue: "ABC-123" }),
      "[ABC-123] Show the weekly summary",
    );
    assert.equal(
      pullRequestTitle({ title: "ABC-123 Show the weekly summary", issue: "ABC-123" }),
      "[ABC-123] Show the weekly summary",
    );
    assert.equal(
      pullRequestTitle({ title: "[ABC-123] Show the weekly summary", issue: "ABC-123" }),
      "[ABC-123] Show the weekly summary",
    );
    assert.equal(
      pullRequestTitle({ title: "ABC-123: Show the weekly summary", issue: "ABC-123", template: "{issue}: {title}" }),
      "ABC-123: Show the weekly summary",
    );
  });

  it("builds a readable remote branch and suffixes a name someone else already has", () => {
    assert.equal(shortJobId(jobId), "ab12");
    assert.equal(shortJobId("widget"), "widget");
    assert.equal(titleSlug("ABC-123: Show the weekly summary", "ABC-123"), "show-the-weekly-summary");
    assert.equal(
      defaultRemoteBranch({ title: "Show the weekly summary", jobId, issue: "ABC-123" }),
      "ABC-123-show-the-weekly-summary",
    );
    assert.equal(
      defaultRemoteBranch({ title: "Show the weekly summary", jobId }),
      "kiln/show-the-weekly-summary-ab12",
    );

    const remotes = new Map<string, string>([["ABC-123-show-the-weekly-summary", "a".repeat(40)]]);
    const chosen = chooseRemoteBranch({
      title: "Show the weekly summary",
      jobId,
      issue: "ABC-123",
      localSha: "b".repeat(40),
      remoteSha: (name) => remotes.get(name) ?? null,
    });
    assert.equal(chosen, "ABC-123-show-the-weekly-summary-ab12");

    const ours = chooseRemoteBranch({
      title: "Show the weekly summary",
      jobId,
      issue: "ABC-123",
      localSha: "a".repeat(40),
      remoteSha: (name) => remotes.get(name) ?? null,
    });
    assert.equal(ours, "ABC-123-show-the-weekly-summary");

    const recorded = chooseRemoteBranch({
      title: "Show the weekly summary",
      jobId,
      localSha: "b".repeat(40),
      remoteSha: () => "c".repeat(40),
      recorded: "yak/run-1",
    });
    assert.equal(recorded, "yak/run-1");
  });

  it("fills a repo branch template and refuses an unsafe result", () => {
    const name = chooseRemoteBranch({
      title: "Show the weekly summary",
      jobId,
      issue: "ABC-123",
      template: "feature/{issue}-{slug}",
      localSha: "a".repeat(40),
      remoteSha: () => null,
    });
    assert.equal(name, "feature/ABC-123-show-the-weekly-summary");
    assert.throws(
      () =>
        chooseRemoteBranch({
          title: "Show the weekly summary",
          jobId,
          template: "..",
          localSha: "a".repeat(40),
          remoteSha: () => null,
        }),
      /not a safe git branch/,
    );
  });
});
