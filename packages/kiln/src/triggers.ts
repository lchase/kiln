import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedKilnConfig } from "./config.js";
import { appendEvent, readEvents, type KilnEvent } from "./events.js";
import { isIgnoredAuthor } from "./feedback.js";
import type { ReviewRequest, ReviewRequestSource } from "./host.js";
import { searchJiraIssues, type JiraPollIssue } from "./intake/jira.js";
import { listValidJobs, writeJob } from "./jobs.js";
import { pausedFrom, spendSnapshot } from "./rails.js";
import { redact } from "./redact.js";
import { ISSUE_KEY, type RouteConfig, type TriggerConfig, type TriggerToggle } from "./schemas.js";
import { REVIEW_WORKFLOW } from "./workflow.js";

/**
 * Triggers and the one router that turns them into jobs.
 * A trigger writes a typed event. The router creates a job or attaches to
 * one. The dedupe key lives on that event, so a restart does not create
 * the job twice. A failed fire records `last_error` and waits for the next
 * slot. Pause and the daily cap record a skip. Nothing is queued.
 *
 * Jira is polled. `jiraIssueEvent` is the seam a webhook can call later.
 * Pull-request activity reuses the feedback loop's snapshot. It does not
 * poll a second time.
 */

export const REVIEW_REQUESTS_TRIGGER = "review-requests";
export const PR_ACTIVITY_TRIGGER = "pr-activity";
/** Minute 0 of every hour, local time. */
export const DEFAULT_REVIEW_CRON = "0 * * * *";
export const DEFAULT_JIRA_EVERY = "5m";

const BUILTIN_TRIGGERS: readonly TriggerConfig[] = [
  { id: REVIEW_REQUESTS_TRIGGER, kind: "schedule", cron: DEFAULT_REVIEW_CRON, enabled: true },
  { id: PR_ACTIVITY_TRIGGER, kind: "pr", enabled: true },
];

const BUILTIN_ROUTES: readonly RouteConfig[] = [
  { id: REVIEW_REQUESTS_TRIGGER, trigger: REVIEW_REQUESTS_TRIGGER, action: "create", workflow: REVIEW_WORKFLOW },
  { id: PR_ACTIVITY_TRIGGER, trigger: PR_ACTIVITY_TRIGGER, action: "attach" },
];

export interface JiraSearch {
  /** Read matching issues. Must not log or return the API token. */
  search(jql: string): JiraPollIssue[];
}

/** One routed fact. `key` is the dedupe id recorded on `trigger.routed`. */
export interface TriggerEvent {
  key: string;
  source: "schedule" | "jira" | "pr" | "review";
  triggerId: string;
  id: string;
  revision: string;
  repo?: string;
  title?: string;
  body?: string;
  author?: string;
  jobId?: string;
  kilnOwn?: boolean;
  workflow?: string;
}

export type RouteDecision =
  | { type: "ignore"; reason: "kiln" }
  | { type: "deduped"; key: string }
  | { type: "unrouted"; key: string }
  | { type: "create"; key: string; workflow: string; repo: string }
  | { type: "attach"; key: string; jobId: string };

export interface TriggerRuntime {
  lastFire?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface TriggerRecent {
  ts: string;
  event: string;
  summary: string;
}

export interface TriggerRow {
  id: string;
  kind: string;
  enabled: boolean;
  schedule: string;
  nextFire?: string;
  lastFire?: string;
  lastError?: string;
  lastErrorAt?: string;
  recent: TriggerRecent[];
}

export interface EvaluateTriggersInput {
  config: LoadedKilnConfig;
  now?: Date;
  /** First evaluation after this process started. A missed cron slot fires once. */
  startup?: boolean;
  reviews?: ReviewRequestSource;
  /** Tests pass a fake. Production searches with the env token when this is omitted. */
  jira?: JiraSearch;
}

interface RuntimeFile {
  [id: string]: TriggerRuntime;
}

interface CronField {
  values: Set<number>;
  /** True only for a bare `*`, so day-of-month and weekday can use cron's OR rule. */
  star: boolean;
}

interface CronExpr {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const REVIEW_REF = /^review:([^:]+):(\d+):([0-9a-f]{7,64})$/i;

export function effectiveTriggers(file: readonly TriggerConfig[] | undefined): TriggerConfig[] {
  const byId = new Map<string, TriggerConfig>();
  for (const trigger of BUILTIN_TRIGGERS) byId.set(trigger.id, { ...trigger });
  for (const trigger of file ?? []) {
    const prior = byId.get(trigger.id);
    byId.set(trigger.id, {
      ...(prior ?? {}),
      ...trigger,
      enabled: trigger.enabled ?? prior?.enabled ?? true,
    });
  }
  return [...byId.values()];
}

export function effectiveRoutes(file: readonly RouteConfig[] | undefined): RouteConfig[] {
  const byId = new Map<string, RouteConfig>();
  for (const route of BUILTIN_ROUTES) byId.set(route.id, { ...route });
  for (const route of file ?? []) byId.set(route.id, { ...route });
  return [...byId.values()];
}

export function knownTrigger(id: string, file: readonly TriggerConfig[] | undefined): boolean {
  return effectiveTriggers(file).some((trigger) => trigger.id === id);
}

/** Enable/disable writes `enabled` and leaves cron, JQL, and repo on the file. */
export function applyTriggerToggles(
  file: readonly TriggerConfig[] | undefined,
  toggles: readonly TriggerToggle[],
): TriggerConfig[] {
  const list = (file ?? []).map((trigger) => ({ ...trigger }));
  for (const toggle of toggles) {
    const index = list.findIndex((trigger) => trigger.id === toggle.id);
    if (index >= 0) {
      const current = list[index];
      if (current) list[index] = { ...current, enabled: toggle.enabled };
      continue;
    }
    const builtin = BUILTIN_TRIGGERS.find((trigger) => trigger.id === toggle.id);
    if (!builtin) continue;
    list.push({ ...builtin, enabled: toggle.enabled });
  }
  return list;
}

/** `label` / `status` compile to JQL. An explicit `jql` wins. */
export function compileJql(trigger: { jql?: string; label?: string; status?: string }): string {
  if (trigger.jql?.trim()) return trigger.jql.trim();
  const parts: string[] = [];
  if (trigger.label?.trim()) parts.push(`labels = ${jqlQuote(trigger.label.trim())}`);
  if (trigger.status?.trim()) parts.push(`status = ${jqlQuote(trigger.status.trim())}`);
  if (parts.length === 0) throw new Error("Jira trigger needs jql, or a label or status.");
  return parts.join(" AND ");
}

/** `30s`, `5m`, or `1h`. Omitted means {@link DEFAULT_JIRA_EVERY}. */
export function parseEvery(raw: string | undefined): number {
  const text = (raw ?? DEFAULT_JIRA_EVERY).trim();
  const match = /^(\d+)(s|m|h)$/.exec(text);
  if (!match?.[1] || !match[2]) throw new Error(`Poll interval ${JSON.stringify(text)} must look like 30s, 5m, or 1h.`);
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Poll interval ${JSON.stringify(text)} must look like 30s, 5m, or 1h.`);
  }
  const unit = match[2];
  const ms = unit === "s" ? count * 1_000 : unit === "m" ? count * 60_000 : count * 3_600_000;
  if (ms < 1_000) throw new Error(`Poll interval ${JSON.stringify(text)} must be at least 1s.`);
  return ms;
}

/**
 * Latest cron minute at or before `now`, in local time.
 * Walking back stops after a year so an impossible expression cannot spin.
 */
export function previousCronSlot(expr: string, now: Date): Date | null {
  const cron = parseCron(expr);
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  const limit = cursor.getTime() - 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() >= limit) {
    if (cronMatches(cron, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

export function nextCronSlot(expr: string, after: Date): Date | null {
  const cron = parseCron(expr);
  const cursor = new Date(after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), after.getMinutes(), 0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(cron, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * The one slot this evaluation may fire.
 * A running tick fires only the slot that contains `now`.
 * Startup fires the latest missed slot once, never the ones behind it.
 */
export function dueCronSlot(expr: string, lastFire: string | undefined, now: Date, startup: boolean): Date | null {
  const slot = previousCronSlot(expr, now);
  if (!slot) return null;
  if (lastFire && Number.isFinite(Date.parse(lastFire)) && slot.getTime() <= Date.parse(lastFire)) return null;
  if (!startup && !sameMinute(slot, now)) return null;
  return slot;
}

/** Kiln's own comment or commit: author `kiln` / `[bot]`, a `kiln:` subject, or a `Kiln-Job` trailer. */
export function isKilnOwnActivity(input: { author?: string; body?: string }): boolean {
  if (input.author && isIgnoredAuthor(input.author)) return true;
  const text = input.body ?? "";
  if (!text.trim()) return false;
  const subject = text.split("\n")[0]?.trim() ?? "";
  if (subject.startsWith("kiln:")) return true;
  return text.split("\n").some((line) => line.trim().startsWith("Kiln-Job:"));
}

export interface PrActivity {
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  comments?: readonly { id: string; author: string; body: string; resolved?: boolean }[];
  reviews?: readonly { id: string; author: string; body: string }[];
  commits?: readonly { sha: string; message: string }[];
}

/** Pull-request activity worth routing. Kiln's own comments and commits are left out. */
export function prTriggerEvents(input: PrActivity): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  const push = (id: string, title: string, author: string | undefined, body: string) => {
    if (isKilnOwnActivity({ ...(author ? { author } : {}), body })) return;
    events.push({
      key: `pr:${input.jobId}:${id}`,
      source: "pr",
      triggerId: PR_ACTIVITY_TRIGGER,
      id,
      revision: input.headSha,
      repo: input.repo,
      title: oneLine(title),
      body,
      ...(author ? { author } : {}),
      jobId: input.jobId,
    });
  };
  for (const comment of input.comments ?? []) {
    if (comment.resolved) continue;
    push(`comment:${comment.id}`, comment.body, comment.author, comment.body);
  }
  for (const review of input.reviews ?? []) {
    if (!review.body.trim()) continue;
    push(`review:${review.id}`, review.body, review.author, review.body);
  }
  for (const commit of input.commits ?? []) {
    push(`commit:${commit.sha}`, commit.message, undefined, commit.message);
  }
  return events;
}

/**
 * One function from a trigger event to a create or an attach.
 * `routed` is the set of keys already stored on `trigger.routed` events.
 */
export function routeTrigger(
  event: TriggerEvent,
  routes: readonly RouteConfig[],
  routed: ReadonlySet<string>,
): RouteDecision {
  if (event.kilnOwn || isKilnOwnActivity({ ...(event.author ? { author: event.author } : {}), ...(event.body ? { body: event.body } : {}) })) {
    return { type: "ignore", reason: "kiln" };
  }
  if (routed.has(event.key)) return { type: "deduped", key: event.key };
  const route = routes.find((candidate) => candidate.trigger === event.triggerId);
  if (!route) return { type: "unrouted", key: event.key };
  if (route.action === "attach") {
    if (!event.jobId) return { type: "unrouted", key: event.key };
    return { type: "attach", key: event.key, jobId: event.jobId };
  }
  const repo = event.repo ?? route.repo;
  const workflow = event.workflow ?? route.workflow;
  if (!repo || !workflow) return { type: "unrouted", key: event.key };
  return { type: "create", key: event.key, workflow, repo };
}

/** A Jira issue, from a poll or (later) a webhook. The dedupe key is the issue, not each edit. */
export function jiraIssueEvent(triggerId: string, repo: string, issue: JiraPollIssue): TriggerEvent {
  return {
    key: `jira:${triggerId}:${issue.key}`,
    source: "jira",
    triggerId,
    id: issue.key,
    revision: issue.updated,
    repo,
    title: oneLine(issue.summary),
    body: issue.description,
  };
}

export function reviewHeadOf(job: { workflow: string; source?: { kind: string; ref: string } }): string | undefined {
  if (job.workflow !== REVIEW_WORKFLOW || job.source?.kind !== "trigger") return undefined;
  return REVIEW_REF.exec(job.source.ref)?.[3];
}

/** Download the pull request head when the checkout does not have that commit yet. */
export function ensureReviewHead(checkout: string, prNumber: number, sha: string): void {
  if (hasCommit(checkout, sha)) return;
  const fetched = spawnSync("git", ["fetch", "--quiet", "origin", `pull/${prNumber}/head`], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (fetched.status !== 0 || !hasCommit(checkout, sha)) {
    throw new Error(`Could not fetch pull request ${prNumber} head ${sha.slice(0, 12)}.`);
  }
}

/**
 * Schedule and Jira triggers for one tick.
 * Pull-request activity is recorded from the snapshot the feedback loop already read.
 */
export function evaluateTriggers(input: EvaluateTriggersInput): void {
  const now = input.now ?? new Date();
  const startup = input.startup ?? false;
  const triggers = effectiveTriggers(input.config.triggers);
  const routes = effectiveRoutes(input.config.routes);
  for (const trigger of triggers) {
    if (trigger.enabled === false) continue;
    if (trigger.kind === "pr") continue;
    try {
      if (trigger.kind === "jira") runJira(input, trigger, routes, now, startup);
      else runSchedule(input, trigger, routes, now, startup);
    } catch (error) {
      noteConfigError(input.config, trigger.id, errorMessage(error), now);
    }
  }
}

/** Fold one already-read pull request snapshot into the trigger log. */
export function recordOwnedPullRequest(config: LoadedKilnConfig, activity: PrActivity, now = new Date()): void {
  const trigger = effectiveTriggers(config.triggers).find((candidate) => candidate.id === PR_ACTIVITY_TRIGGER);
  if (!trigger || trigger.enabled === false) return;
  const pending = prTriggerEvents(activity);
  if (pending.length === 0) return;
  const reason = blockReason(config, now);
  if (reason) {
    noteSkip(config, PR_ACTIVITY_TRIGGER, reason, hourStamp(now), now);
    return;
  }
  const routes = effectiveRoutes(config.routes);
  for (const event of pending) ingest(config, event, routes, now);
}

export function triggerRows(config: LoadedKilnConfig, events: readonly KilnEvent[], now = new Date()): TriggerRow[] {
  const runtime = readRuntime(config.kilnDir);
  return effectiveTriggers(config.triggers).map((trigger) => {
    const state = runtime[trigger.id];
    const recent = events
      .filter((event) => isTriggerEvent(event) && event.properties.trigger_id === trigger.id)
      .slice(-8)
      .reverse()
      .map((event) => ({
        ts: event.ts,
        event: event.event,
        summary: triggerSummary(event),
      }));
    return {
      id: trigger.id,
      kind: trigger.kind,
      enabled: trigger.enabled !== false,
      schedule: scheduleLabel(trigger),
      ...(nextFire(trigger, state, now) ? { nextFire: nextFire(trigger, state, now) } : {}),
      ...(state?.lastFire && Number.isFinite(Date.parse(state.lastFire)) ? { lastFire: state.lastFire } : {}),
      ...(state?.lastError ? { lastError: state.lastError } : {}),
      ...(state?.lastErrorAt ? { lastErrorAt: state.lastErrorAt } : {}),
      recent,
    };
  });
}

function runSchedule(
  input: EvaluateTriggersInput,
  trigger: TriggerConfig,
  routes: readonly RouteConfig[],
  now: Date,
  startup: boolean,
): void {
  if (!trigger.cron) throw new Error(`Trigger ${trigger.id} needs a cron expression.`);
  const state = readRuntime(input.config.kilnDir)[trigger.id];
  const slot = dueCronSlot(trigger.cron, state?.lastFire, now, startup);
  if (!slot) return;
  const stamp = slot.toISOString();
  const reason = blockReason(input.config, now);
  if (reason) {
    noteSkip(input.config, trigger.id, reason, stamp, now);
    remember(input.config.kilnDir, trigger.id, { lastFire: stamp });
    return;
  }
  const route = routes.find((candidate) => candidate.trigger === trigger.id);
  const reviews = route?.workflow === REVIEW_WORKFLOW || trigger.id === REVIEW_REQUESTS_TRIGGER;
  if (reviews) {
    if (!input.reviews) return;
    let requests: ReviewRequest[];
    try {
      requests = input.reviews.list(
        Object.entries(input.config.repos).map(([name, repo]) => ({ name, path: repo.path })),
      );
    } catch (error) {
      failSlot(input.config, trigger.id, stamp, errorMessage(error), now);
      return;
    }
    succeedSlot(input.config.kilnDir, trigger.id, stamp);
    appendFire(input.config, {
      key: `schedule:${trigger.id}:${stamp}`,
      source: "schedule",
      triggerId: trigger.id,
      id: stamp,
      revision: stamp,
    });
    for (const request of requests) {
      try {
        ingestReview(input.config, request, routes, now);
      } catch (error) {
        remember(input.config.kilnDir, trigger.id, {
          lastFire: stamp,
          lastError: publicError(errorMessage(error)),
          lastErrorAt: now.toISOString(),
        });
        appendFailed(input.config, trigger.id, publicError(errorMessage(error)), `review:${request.repo}:${request.number}`, now);
      }
    }
    return;
  }
  succeedSlot(input.config.kilnDir, trigger.id, stamp);
  ingest(
    input.config,
    {
      key: `schedule:${trigger.id}:${stamp}`,
      source: "schedule",
      triggerId: trigger.id,
      id: stamp,
      revision: stamp,
      ...(route?.repo ? { repo: route.repo } : {}),
      title: trigger.id,
      ...(route?.workflow ? { workflow: route.workflow } : {}),
    },
    routes,
    now,
  );
}

function ingestReview(
  config: LoadedKilnConfig,
  request: ReviewRequest,
  routes: readonly RouteConfig[],
  now: Date,
): void {
  const sha = request.headSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`Pull request ${request.number} has no head SHA.`);
  const repo = config.repos[request.repo];
  if (!repo) throw new Error(`Pull request ${request.number} is not in a registered repo.`);
  ensureReviewHead(repo.path, request.number, sha);
  const base = repo.base ?? "the default branch";
  const url = httpUrl(request.url);
  const title = oneLine(request.title) || `PR ${request.number}`;
  ingest(
    config,
    {
      key: `review:${request.repo}:${request.number}:${sha}`,
      source: "review",
      triggerId: REVIEW_REQUESTS_TRIGGER,
      id: String(request.number),
      revision: sha,
      repo: request.repo,
      title: `Review: ${title}`,
      workflow: REVIEW_WORKFLOW,
      body: reviewSpec({ title, url, number: request.number, sha, base }),
    },
    routes,
    now,
  );
}

function runJira(
  input: EvaluateTriggersInput,
  trigger: TriggerConfig,
  routes: readonly RouteConfig[],
  now: Date,
  _startup: boolean,
): void {
  if (!trigger.repo) throw new Error(`Jira trigger ${trigger.id} needs a repo.`);
  const every = parseEvery(trigger.every);
  const state = readRuntime(input.config.kilnDir)[trigger.id];
  const last = state?.lastFire ? Date.parse(state.lastFire) : Number.NaN;
  if (Number.isFinite(last) && now.getTime() - last < every) return;
  const stamp = now.toISOString();
  const reason = blockReason(input.config, now);
  if (reason) {
    noteSkip(input.config, trigger.id, reason, stamp, now);
    remember(input.config.kilnDir, trigger.id, { lastFire: stamp });
    return;
  }
  const jql = compileJql(trigger);
  const client = input.jira ?? { search: (query: string) => searchJiraIssues(input.config, query) };
  let issues: JiraPollIssue[];
  try {
    issues = client.search(jql);
  } catch (error) {
    failSlot(input.config, trigger.id, stamp, errorMessage(error), now);
    return;
  }
  succeedSlot(input.config.kilnDir, trigger.id, stamp);
  const route = routes.find((candidate) => candidate.trigger === trigger.id);
  for (const issue of issues) {
    try {
      ingest(
        input.config,
        {
          ...jiraIssueEvent(trigger.id, trigger.repo, issue),
          ...(route?.workflow ? { workflow: route.workflow } : {}),
        },
        routes,
        now,
      );
    } catch (error) {
      remember(input.config.kilnDir, trigger.id, {
        lastFire: stamp,
        lastError: publicError(errorMessage(error)),
        lastErrorAt: now.toISOString(),
      });
      appendFailed(input.config, trigger.id, publicError(errorMessage(error)), issue.key, now);
    }
  }
}

/**
 * Apply one route. A key already on a `trigger.routed` event, or already
 * stored as a job `source.ref`, does not create a second job.
 */
function ingest(
  config: LoadedKilnConfig,
  event: TriggerEvent,
  routes: readonly RouteConfig[],
  now: Date,
): void {
  const events = readEvents(config.kilnDir, { warn: () => {} });
  const routed = routedKeys(events);
  const decision = routeTrigger(event, routes, routed);
  if (decision.type === "ignore" || decision.type === "deduped") return;
  if (decision.type === "unrouted") {
    noteConfigError(config, event.triggerId, `No route for trigger ${event.triggerId}.`, now);
    return;
  }
  appendFire(config, event, now);
  if (decision.type === "attach") {
    appendRouted(config, event, decision.jobId, "attach", undefined, now);
    return;
  }
  const existing = listValidJobs(config).find((job) => job.source?.kind === "trigger" && job.source.ref === event.key);
  if (existing) {
    appendRouted(config, event, existing.id, "create", decision.workflow, now);
    return;
  }
  const title = oneLine(event.title ?? "") || event.id;
  const specText = redact(event.body?.trim() || `# ${title}\n`);
  const issue = ISSUE_KEY.test(event.id) ? event.id : undefined;
  const written = writeJob(config, {
    workflow: decision.workflow,
    repo: decision.repo,
    specText: specText.endsWith("\n") ? specText : `${specText}\n`,
    title,
    dependsOn: [],
    ...(issue ? { issue } : {}),
    source: { kind: "trigger", ref: event.key },
    now,
  });
  appendRouted(config, event, written.job.id, "create", decision.workflow, now);
}

function reviewSpec(input: { title: string; url?: string; number: number; sha: string; base: string }): string {
  const lines = [`# Draft review: ${input.title}`, ""];
  if (input.url) lines.push(`Pull request: ${input.url}`);
  lines.push(`Number: ${input.number}`, `Head: ${input.sha}`, `Base: ${input.base}`, "");
  lines.push(
    "Read the change and return a draft review.",
    "Do not post, approve, merge, or push.",
    "Approving the gate keeps the draft. Kiln does not post it to GitHub.",
    "",
  );
  return lines.join("\n");
}

function appendFire(config: LoadedKilnConfig, event: TriggerEvent, now?: Date): void {
  appendEvent(config.kilnDir, {
    job_id: null,
    event: "trigger.fired",
    ...(now ? { ts: now.toISOString() } : {}),
    properties: {
      trigger_id: event.triggerId,
      source: event.source,
      dedupe: event.key,
      external_id: event.id,
      revision: event.revision,
      ...(event.repo ? { repo: event.repo } : {}),
      ...(event.title ? { title: oneLine(event.title) } : {}),
      once: `fired:${event.key}`,
    },
  });
}

function appendRouted(
  config: LoadedKilnConfig,
  event: TriggerEvent,
  jobId: string,
  action: "create" | "attach",
  workflow: string | undefined,
  now: Date,
): void {
  appendEvent(config.kilnDir, {
    job_id: jobId,
    event: "trigger.routed",
    ts: now.toISOString(),
    properties: {
      trigger_id: event.triggerId,
      dedupe: event.key,
      action,
      ...(workflow ? { workflow } : {}),
      ...(event.repo ? { repo: event.repo } : {}),
      once: `routed:${event.key}`,
    },
  });
}

function appendFailed(config: LoadedKilnConfig, triggerId: string, error: string, slot: string, now: Date): void {
  appendEvent(config.kilnDir, {
    job_id: null,
    event: "trigger.failed",
    ts: now.toISOString(),
    properties: {
      trigger_id: triggerId,
      error,
      once: `failed:${triggerId}:${slot}`,
    },
  });
}

function failSlot(config: LoadedKilnConfig, triggerId: string, stamp: string, message: string, now: Date): void {
  const error = publicError(message);
  remember(config.kilnDir, triggerId, { lastFire: stamp, lastError: error, lastErrorAt: now.toISOString() });
  appendFailed(config, triggerId, error, stamp, now);
}

function succeedSlot(kilnDir: string, triggerId: string, stamp: string): void {
  remember(kilnDir, triggerId, { lastFire: stamp, lastError: undefined, lastErrorAt: undefined });
}

function noteSkip(
  config: LoadedKilnConfig,
  triggerId: string,
  reason: "paused" | "capped",
  stamp: string,
  now: Date,
): void {
  appendEvent(config.kilnDir, {
    job_id: null,
    event: "trigger.skipped",
    ts: now.toISOString(),
    properties: {
      trigger_id: triggerId,
      reason,
      once: `skipped:${triggerId}:${stamp}:${reason}`,
    },
  });
}

function noteConfigError(config: LoadedKilnConfig, triggerId: string, message: string, now: Date): void {
  const error = publicError(message);
  const current = readRuntime(config.kilnDir)[triggerId];
  if (current?.lastError === error) return;
  remember(config.kilnDir, triggerId, { lastError: error, lastErrorAt: now.toISOString() });
  appendFailed(config, triggerId, error, `config:${error}`, now);
}

function blockReason(config: LoadedKilnConfig, now: Date): "paused" | "capped" | undefined {
  const events = readEvents(config.kilnDir, { warn: () => {} });
  if (pausedFrom(events)) return "paused";
  const spend = spendSnapshot(events, config.dailyDollarCap, now);
  if (spend.blocked) return "capped";
  return undefined;
}

function routedKeys(events: readonly KilnEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.event === "trigger.routed") keys.add(event.properties.dedupe);
  }
  return keys;
}

function isTriggerEvent(
  event: KilnEvent,
): event is Extract<KilnEvent, { event: "trigger.fired" | "trigger.routed" | "trigger.failed" | "trigger.skipped" }> {
  return (
    event.event === "trigger.fired" ||
    event.event === "trigger.routed" ||
    event.event === "trigger.failed" ||
    event.event === "trigger.skipped"
  );
}

function triggerSummary(event: KilnEvent): string {
  if (event.event === "trigger.failed") return event.properties.error;
  if (event.event === "trigger.skipped") return event.properties.reason;
  if (event.event === "trigger.routed") return `${event.properties.action} ${event.properties.dedupe}`;
  if (event.event === "trigger.fired") return event.properties.dedupe;
  return event.event;
}

function scheduleLabel(trigger: TriggerConfig): string {
  if (trigger.kind === "schedule") return trigger.cron ?? DEFAULT_REVIEW_CRON;
  if (trigger.kind === "jira") return trigger.every ?? DEFAULT_JIRA_EVERY;
  return "each tick";
}

function nextFire(trigger: TriggerConfig, state: TriggerRuntime | undefined, now: Date): string | undefined {
  if (trigger.enabled === false || trigger.kind === "pr") return undefined;
  if (trigger.kind === "jira") {
    try {
      const every = parseEvery(trigger.every);
      const last = state?.lastFire ? Date.parse(state.lastFire) : Number.NaN;
      const at = Number.isFinite(last) ? last + every : now.getTime();
      return new Date(at).toISOString();
    } catch {
      return undefined;
    }
  }
  if (!trigger.cron) return undefined;
  try {
    const slot = previousCronSlot(trigger.cron, now);
    const last = state?.lastFire ? Date.parse(state.lastFire) : Number.NaN;
    if (slot && (!Number.isFinite(last) || slot.getTime() > last)) return slot.toISOString();
    return nextCronSlot(trigger.cron, now)?.toISOString();
  } catch {
    return undefined;
  }
}

function remember(kilnDir: string, id: string, patch: TriggerRuntime): void {
  const all = readRuntime(kilnDir);
  const prior = all[id] ?? {};
  const next: TriggerRuntime = { ...prior };
  if (patch.lastFire !== undefined) next.lastFire = patch.lastFire;
  if (patch.lastError === undefined && "lastError" in patch) delete next.lastError;
  else if (patch.lastError !== undefined) next.lastError = patch.lastError;
  if (patch.lastErrorAt === undefined && "lastErrorAt" in patch) delete next.lastErrorAt;
  else if (patch.lastErrorAt !== undefined) next.lastErrorAt = patch.lastErrorAt;
  all[id] = next;
  const path = join(kilnDir, "triggers", "state.json");
  mkdirSync(join(kilnDir, "triggers"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
}

function readRuntime(kilnDir: string): RuntimeFile {
  const path = join(kilnDir, "triggers", "state.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as RuntimeFile;
  } catch {
    return {};
  }
}

function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron ${JSON.stringify(expr)} needs 5 fields (minute hour day month weekday).`);
  }
  const minute = parseField(parts[0] ?? "", 0, 59);
  const hour = parseField(parts[1] ?? "", 0, 23);
  const dom = parseField(parts[2] ?? "", 1, 31);
  const month = parseField(parts[3] ?? "", 1, 12);
  const dow = parseField(parts[4] ?? "", 0, 7);
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

function parseField(raw: string, min: number, max: number): CronField {
  if (!raw || /\s/.test(raw)) throw new Error(`Cron field ${JSON.stringify(raw)} is not valid.`);
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) throw new Error(`Cron field ${JSON.stringify(raw)} is not valid.`);
    const pieces = part.split("/");
    if (pieces.length > 2) throw new Error(`Cron field ${JSON.stringify(raw)} is not valid.`);
    const step = pieces.length === 2 ? Number(pieces[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Cron field ${JSON.stringify(raw)} is not valid.`);
    const base = pieces[0] ?? "";
    let start = min;
    let end = max;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2) throw new Error(`Cron field ${JSON.stringify(raw)} is not valid.`);
      start = Number(bounds[0]);
      end = Number(bounds[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`Cron field ${JSON.stringify(raw)} is outside ${min}-${max}.`);
      }
    } else {
      start = Number(base);
      end = pieces.length === 2 ? max : start;
      if (!Number.isInteger(start) || start < min || start > max) {
        throw new Error(`Cron field ${JSON.stringify(raw)} is outside ${min}-${max}.`);
      }
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`Cron field ${JSON.stringify(raw)} matches nothing.`);
  return { values, star: raw === "*" };
}

function cronMatches(cron: CronExpr, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes())) return false;
  if (!cron.hour.values.has(date.getHours())) return false;
  if (!cron.month.values.has(date.getMonth() + 1)) return false;
  const dom = cron.dom.values.has(date.getDate());
  const dow = cron.dow.values.has(date.getDay());
  if (cron.dom.star && cron.dow.star) return true;
  if (cron.dom.star) return dow;
  if (cron.dow.star) return dom;
  return dom || dow;
}

function sameMinute(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate() &&
    left.getHours() === right.getHours() &&
    left.getMinutes() === right.getMinutes()
  );
}

function hourStamp(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).toISOString();
}

function hasCommit(checkout: string, sha: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
    cwd: checkout,
    encoding: "utf8",
  });
  return result.status === 0;
}

function jqlQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function publicError(message: string): string {
  return redact(message)
    .replace(/(?:\/|[A-Za-z]:\\)[^\s"'`]+/g, "[path]")
    .slice(0, 400);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
