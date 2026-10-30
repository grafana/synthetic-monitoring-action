import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import type { CheckDoc } from "./checks-data.js";
import { type CheckTestResult, resolveSmokeChecks, runSmoke } from "./smoke.js";

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

// smoke-check-file names exactly one check; smoke-check-files takes newline-separated
// paths or globs. Both are relative to the caller's checkout, not the action's directory.
function loadChecks(): CheckDoc[] {
  const file = process.env.SM_ACTION_SMOKE_CHECK_FILE;
  const files = process.env.SM_ACTION_SMOKE_CHECK_FILES;
  if (file && files) {
    throw new Error("Set only one of SM_ACTION_SMOKE_CHECK_FILE (smoke-check-file) or SM_ACTION_SMOKE_CHECK_FILES.");
  }
  if (!file && !files) {
    throw new Error("Set SM_ACTION_SMOKE_CHECK_FILE (smoke-check-file) or SM_ACTION_SMOKE_CHECK_FILES.");
  }

  const cwd = process.env.SM_ACTION_WORKSPACE || process.cwd();
  if (file) {
    const docs = resolveSmokeChecks([file], cwd);
    if (docs.length !== 1) {
      throw new Error(`smoke-check-file must name exactly one check, found ${docs.length}; use smoke-check-files.`);
    }
    return docs;
  }
  const patterns = files!
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return resolveSmokeChecks(patterns, cwd);
}

// Runs the checks once each (not saved) via `gcx synthetic-monitoring checks test`,
// after optionally waiting for their targets to serve the expected body. The markdown
// report goes to stdout, the step summary and SM_ACTION_SMOKE_REPORT_FILE; the job fails
// unless every probe of every check reports success.
async function main(): Promise<void> {
  const checks = loadChecks();

  const waitTimeout = seconds("SM_ACTION_SMOKE_WAIT_TIMEOUT", 0);
  const out = await runSmoke({
    checks,
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

  // One result file even for several checks: the first failure is the one worth
  // diagnosing, and for a clean run the first check stands in for the rest.
  const failing = out.outcomes.filter((o) => !o.evaluation.passed);
  const primary = failing[0] ?? out.outcomes[0];
  if (primary) {
    const resultFile = join(process.env.RUNNER_TEMP || tmpdir(), "sm-action-smoke-result.json");
    writeFileSync(resultFile, JSON.stringify(primary.result), "utf8");
    setOutput("smoke-result", resultFile);
    setOutput("adhoc-id", primary.result.adhoc_id);
  }
  setOutput(
    "failed-probes",
    out.outcomes.flatMap((o) => o.evaluation.failed.map((f) => `${o.name}/${f}`)).join(","),
  );

  for (const note of out.outcomes.flatMap((o) => o.notes)) console.error(`::warning::${note}`);
  if (!out.passed) {
    if (out.notReady) console.error(`::error::target not ready: ${out.notReady.join(", ")}`);
    for (const o of failing) {
      const reason = o.evaluation.total === 0 ? "no probe results" : o.evaluation.failed.join(", ");
      console.error(`::error::${o.name}: ${reason}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
