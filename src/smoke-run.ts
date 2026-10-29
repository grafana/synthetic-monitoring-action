import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { type CheckDoc, parseCheckDocs } from "./checks-data.js";
import { type CheckTestResult, runSmoke } from "./smoke.js";
import { requireEnv } from "./gh.js";

function gcxCheckTest(doc: CheckDoc): CheckTestResult {
  const dir = mkdtempSync(join(tmpdir(), "sm-action-smoke-"));
  const file = join(dir, "check.yaml");
  writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }), "utf8");

  const args = ["synthetic-monitoring", "checks", "test", "-f", file, "-o", "json"];
  const logsUid = process.env.SM_ACTION_SMOKE_LOGS_DATASOURCE_UID;
  if (logsUid) args.push("--logs-datasource-uid", logsUid);

  const result = spawnSync("gcx", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gcx ${args.join(" ")} failed: ${result.stderr || result.error}`);
  }
  return JSON.parse(result.stdout) as CheckTestResult;
}

function seconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number of seconds, got "${raw}"`);
  return n;
}

function setOutput(name: string, value: string): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${name}=${value}\n`);
}

// Runs one check once (not saved) via `gcx synthetic-monitoring checks test`, after
// optionally waiting for the target to serve the expected body. The markdown report
// goes to stdout (tee'd into the PR comment) and the step summary; the job fails
// unless every probe reports success.
async function main(): Promise<void> {
  const checkFile = requireEnv("SM_ACTION_SMOKE_CHECK_FILE");
  const docs = parseCheckDocs(readFileSync(checkFile, "utf8"));
  if (docs.length !== 1) {
    throw new Error(`${checkFile} must contain exactly one check, found ${docs.length}`);
  }

  const waitTimeout = seconds("SM_ACTION_SMOKE_WAIT_TIMEOUT", 0);
  const out = await runSmoke({
    check: docs[0]!,
    options: {
      target: process.env.SM_ACTION_SMOKE_TARGET || undefined,
      cacheBust: process.env.SM_ACTION_SMOKE_CACHE_BUST || undefined,
      bodyRegexp: process.env.SM_ACTION_SMOKE_BODY_REGEXP || undefined,
    },
    wait:
      waitTimeout > 0
        ? { timeoutMs: waitTimeout * 1000, intervalMs: seconds("SM_ACTION_SMOKE_WAIT_INTERVAL", 15) * 1000 }
        : undefined,
    runCheckTest: gcxCheckTest,
  });

  process.stdout.write(`${out.report}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${out.report}\n`);

  // Written here rather than tee'd so later steps and callers can rely on the path.
  const reportFile = process.env.SM_ACTION_SMOKE_REPORT_FILE;
  if (reportFile) {
    writeFileSync(reportFile, `${out.report}\n`, "utf8");
    setOutput("smoke-report", reportFile);
  }

  if (out.result) {
    const resultFile = join(process.env.RUNNER_TEMP || tmpdir(), "sm-action-smoke-result.json");
    writeFileSync(resultFile, JSON.stringify(out.result), "utf8");
    setOutput("smoke-result", resultFile);
    setOutput("adhoc-id", out.result.adhoc_id);
  }
  setOutput("failed-probes", out.evaluation.failed.join(","));

  if (!out.evaluation.passed) {
    const reason = !out.result
      ? "target not ready"
      : out.evaluation.total === 0
        ? "no probe results"
        : out.evaluation.failed.join(", ");
    console.error(`::error::${docs[0]!.metadata.name}: ${reason}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
