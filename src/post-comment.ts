import { readFileSync } from "node:fs";
import { ghApiGet, ghApiWrite, requireEnv } from "./gh.js";

// Deterministic CI glue, no LLM involved: finds this feature's previous comment on the
// PR (by marker) and edits it in place, so re-pushes update one comment instead of
// spamming a new one every run. Different features (impact report vs. sync plan) pass
// different markers so they don't clobber each other's sticky comment.
const DEFAULT_MARKER = "<!-- sm-action-report -->";

interface Comment {
  id: number;
  body: string;
}

// A "sync apply" run is triggered by a push (e.g. to main, post-merge) rather than a
// pull_request event, so there's no event.pull_request.number to read — the PR has to
// be looked up by the commit it produced instead.
function resolvePrNumberFromCommit(repo: string): string {
  const sha = requireEnv("GITHUB_SHA");
  const prs = JSON.parse(ghApiGet(`repos/${repo}/commits/${sha}/pulls`)) as { number: number }[];
  if (prs.length === 0) {
    throw new Error(`No pull request found for commit ${sha} on ${repo} — nothing to comment on.`);
  }
  return String(prs[0]!.number);
}

function resolvePrNumber(repo: string): string {
  const override = process.env.SM_ACTION_PR_NUMBER;
  if (override) return override;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath
    ? (JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number?: number } })
    : undefined;
  const number = event?.pull_request?.number;
  return number ? String(number) : resolvePrNumberFromCommit(repo);
}

function main(): void {
  const reportPath = process.argv[2];
  if (!reportPath) {
    throw new Error("usage: post-comment.ts <report-file> [marker]");
  }
  const marker = process.argv[3] ?? DEFAULT_MARKER;
  const report = readFileSync(reportPath, "utf8").trim();

  const repo = requireEnv("GITHUB_REPOSITORY");
  const prNumber = resolvePrNumber(repo);
  const body = `${marker}\n${report}`;

  const comments = JSON.parse(ghApiGet(`repos/${repo}/issues/${prNumber}/comments`)) as Comment[];
  const existing = comments.find((c) => c.body.includes(marker));

  if (existing) {
    ghApiWrite(`repos/${repo}/issues/comments/${existing.id}`, "PATCH", { body });
    console.log(`Updated comment ${existing.id} on ${repo}#${prNumber}`);
  } else {
    ghApiWrite(`repos/${repo}/issues/${prNumber}/comments`, "POST", { body });
    console.log(`Created new comment on ${repo}#${prNumber}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
