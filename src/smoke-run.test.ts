import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const fixtures = join(root, "fixtures");

interface Run {
  status: number | null;
  stdout: string;
  report: string | undefined;
  outputs: Record<string, string>;
}

// Runs the real entrypoint with a fake `gcx` on PATH that either prints a smoke
// fixture or fails, so the I/O shell is exercised without Grafana access.
function runSmokeEntrypoint(gcx: { fixture: string } | { fail: true }): Run {
  const dir = mkdtempSync(join(tmpdir(), "smoke-run-test-"));
  const bin = join(dir, "bin");
  const fake = join(bin, "gcx");
  const script =
    "fixture" in gcx
      ? `#!/bin/sh\ncat "${join(fixtures, "smoke", gcx.fixture)}"\n`
      : `#!/bin/sh\necho "gcx: boom" >&2\nexit 2\n`;
  mkdirSync(bin);
  writeFileSync(fake, script);
  chmodSync(fake, 0o755);

  const reportFile = join(dir, "report.md");
  const outputFile = join(dir, "github-output");
  writeFileSync(outputFile, "");

  const res = spawnSync("node", ["--import", "tsx", join(root, "src", "smoke-run.ts")], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: outputFile,
      SM_ACTION_SMOKE_CHECK_FILE: join(fixtures, "shared-job-checks", "web-2001.yaml"),
      SM_ACTION_SMOKE_REPORT_FILE: reportFile,
    },
  });

  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  return {
    status: res.status,
    stdout: res.stdout,
    report: existsSync(reportFile) ? readFileSync(reportFile, "utf8") : undefined,
    outputs,
  };
}

test("all probes succeed: exits 0, writes the report file and sets smoke-report", () => {
  const run = runSmokeEntrypoint({ fixture: "all-success.json" });
  assert.equal(run.status, 0);
  assert.match(run.report ?? "", /\| Probe \| Status \|/);
  assert.match(run.report ?? "", /probes passed\./);
  assert.ok(run.outputs["smoke-report"], "smoke-report output is set");
  assert.equal(readFileSync(run.outputs["smoke-report"]!, "utf8"), run.report);
});

test("a failing probe: exits 1 but still writes the report and failed-probes", () => {
  const run = runSmokeEntrypoint({ fixture: "one-failure.json" });
  assert.equal(run.status, 1);
  assert.match(run.report ?? "", /1 of 3 probes failed: Frankfurt=failure/);
  assert.ok(run.outputs["smoke-report"], "smoke-report output is set");
  assert.equal(run.outputs["failed-probes"], "Frankfurt=failure");
});

test("no probe results: exits 1 and the report says so", () => {
  const run = runSmokeEntrypoint({ fixture: "no-probes.json" });
  assert.equal(run.status, 1);
  assert.match(run.report ?? "", /No probe results\./);
  assert.ok(run.outputs["smoke-report"], "smoke-report output is set");
});

test("gcx fails: exits 1, no report, smoke-report unset", () => {
  const run = runSmokeEntrypoint({ fail: true });
  assert.equal(run.status, 1);
  assert.equal(run.report, undefined);
  assert.equal(run.outputs["smoke-report"], undefined);
});
