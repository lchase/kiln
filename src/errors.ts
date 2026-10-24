import type { PlanIssue } from "./validate.js";

export class PlannerOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerOutputError";
  }
}

export class PlanValidationError extends Error {
  readonly issues: PlanIssue[];

  constructor(issues: PlanIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}
