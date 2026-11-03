import type { KilnEvent } from "./events.js";
import { readEvents } from "./events.js";
import { redact } from "./redact.js";
import { formatSpend, spendSnapshot, type SpendSnapshot } from "./rails.js";

/**
 * Interventions are derived from the event log. Nothing is stored beside it.
 * A human had to act when a gate was rejected, a job was retried by hand,
 * a gate carried a manual edit note, or the job stopped as needs-human.
 */

const SINCE = /^(\d+)([dhms])$/;
const REASON_RANK = ["gate rejected", "manual edit", "re-queued or retried by hand"];

export interface LedgerOptions {
  /** Inclusive lower bound. Omit to count the whole log. */
  since?: Date;
  /** Repo name from the job, or from an event that recorded one. */
  repo?: string;
  now?: Date;
  /** Included so the ledger can print today's spend. Omit the field to skip the line. */
  dailyDollarCap?: number;
  spend?: SpendSnapshot;
}

export interface LedgerRow {
  repo: string;
  jobId: string;
  reasons: { reason: string; count: number }[];
  total: number;
}

/** `7d`, `12h`, `30m`, `45s`, or an ISO-8601 time. */
export function parseSince(raw: string, now = new Date()): Date {
  const match = SINCE.exec(raw.trim());
  if (match?.[1] && match[2]) {
    const count = Number(match[1]);
    const unit = match[2];
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
    return new Date(now.getTime() - count * ms);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--since ${JSON.stringify(raw)} is not a duration like 7d or an ISO-8601 time.`);
  }
  return new Date(parsed);
}

export function ledgerRows(events: readonly KilnEvent[], options: LedgerOptions = {}): LedgerRow[] {
  const repos = repoByJob(events);
  const counts = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (!event.job_id) continue;
    if (options.since && Date.parse(event.ts) < options.since.getTime()) continue;
    const repo = repos.get(event.job_id) ?? "(no repo)";
    if (options.repo !== undefined && repo !== options.repo) continue;
    for (const reason of reasonsFor(event)) {
      const jobs = counts.get(repo) ?? new Map<string, number>();
      const key = `${event.job_id}\0${reason}`;
      jobs.set(key, (jobs.get(key) ?? 0) + 1);
      counts.set(repo, jobs);
    }
  }
  const rows: LedgerRow[] = [];
  for (const repo of [...counts.keys()].sort()) {
    const jobs = counts.get(repo);
    if (!jobs) continue;
    const byJob = new Map<string, { reason: string; count: number }[]>();
    for (const [key, count] of jobs) {
      const split = key.indexOf("\0");
      const jobId = key.slice(0, split);
      const reason = key.slice(split + 1);
      const list = byJob.get(jobId) ?? [];
      list.push({ reason, count });
      byJob.set(jobId, list);
    }
    for (const jobId of [...byJob.keys()].sort()) {
      const reasons = byJob.get(jobId) ?? [];
      reasons.sort((left, right) => rank(left.reason) - rank(right.reason) || left.reason.localeCompare(right.reason));
      const total = reasons.reduce((sum, item) => sum + item.count, 0);
      rows.push({ repo, jobId, reasons, total });
    }
  }
  return rows;
}

export function renderLedger(events: readonly KilnEvent[], options: LedgerOptions = {}): string {
  const spend =
    options.spend ??
    (options.dailyDollarCap !== undefined || options.now
      ? spendSnapshot(events, options.dailyDollarCap, options.now ?? new Date())
      : undefined);
  const head = spend ? `${formatSpend(spend)}\n` : "";
  const rows = ledgerRows(events, options);
  if (rows.length === 0) return redact(`${head}0 interventions\n`);
  const lines: string[] = [];
  let grand = 0;
  let index = 0;
  while (index < rows.length) {
    const repo = rows[index]?.repo ?? "";
    const group: LedgerRow[] = [];
    while (index < rows.length && rows[index]?.repo === repo) {
      const row = rows[index];
      if (row) group.push(row);
      index += 1;
    }
    const repoTotal = group.reduce((sum, row) => sum + row.total, 0);
    lines.push(`${repo}  ${repoTotal}`);
    for (const row of group) {
      lines.push(`  ${row.jobId}  ${row.total}`);
      for (const reason of row.reasons) lines.push(`    ${reason.reason}  ${reason.count}`);
    }
    grand += repoTotal;
  }
  lines.push("");
  lines.push(`${grand} ${grand === 1 ? "intervention" : "interventions"}`);
  return redact(`${head}${lines.join("\n")}\n`);
}

export function renderLedgerFile(kilnDir: string, options: LedgerOptions = {}): string {
  const events = readEvents(kilnDir);
  const spend = spendSnapshot(events, options.dailyDollarCap, options.now ?? new Date());
  return renderLedger(events, { ...options, spend });
}

function reasonsFor(event: KilnEvent): string[] {
  const reasons: string[] = [];
  if (event.event === "gate.resolved" && event.properties.decision === "reject") reasons.push("gate rejected");
  if ((event.event === "gate.resolved" || event.event === "gate.opened") && hasEdit(event.properties)) {
    reasons.push("manual edit");
  }
  if (event.event === "job.retried") reasons.push("re-queued or retried by hand");
  if (event.event === "needs-human") reasons.push(`needs-human (${event.properties.reason})`);
  return reasons;
}

function hasEdit(properties: { note?: string; edit?: string }): boolean {
  return Boolean(properties.note?.trim() || properties.edit?.trim());
}

function repoByJob(events: readonly KilnEvent[]): Map<string, string> {
  const repos = new Map<string, string>();
  for (const event of events) {
    if (event.event === "job.added" && event.job_id) repos.set(event.job_id, event.properties.repo);
  }
  for (const event of events) {
    if (!event.job_id || repos.has(event.job_id)) continue;
    const repo = repoOf(event);
    if (repo) repos.set(event.job_id, repo);
  }
  return repos;
}

function repoOf(event: KilnEvent): string | undefined {
  if (event.event === "job.added" || event.event === "job.retried" || event.event === "run.started") {
    return event.properties.repo;
  }
  if (event.event === "gate.resolved") return event.properties.repo;
  return undefined;
}

function rank(reason: string): number {
  const index = REASON_RANK.indexOf(reason);
  if (index >= 0) return index;
  if (reason.startsWith("needs-human")) return REASON_RANK.length;
  return REASON_RANK.length + 1;
}
