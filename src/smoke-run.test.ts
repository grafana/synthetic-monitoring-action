import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const fixtures = join(root, "fixtures");
const web2001 = join(fixtures, "shared-job-checks", "web-2001.yaml");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  report: string | undefined;
  outputs: Record<string, string>;
}

type FakeGcx =
  /** Prints this smoke fixture for every check. */
  | { fixture: string }
  /** Prints the fixture named for the check being tested. */
  | { byName: Record<string, string> }
  | { fail: true };

function fakeGcxScript(gcx: FakeGcx): string {
  const smoke = (f: string) => join(fixtures, "smoke", f);
  if ("fail" in gcx) return `#!/bin/sh\necho "gcx: boom" >&2\nexit 2\n`;
  if ("fixture" in gcx) return `#!/bin/sh\ncat "${smoke(gcx.fixture)}"\n`;
  // $5 is the file: gcx synthetic-monitoring checks test -f FILE -o json
  const cases = Object.entries(gcx.byName)
    .map(([name, f]) => `  ${name}) cat "${smoke(f)}" ;;`)
    .join("\n");
  return `#!/bin/sh
name=$(sed -n 's/^  name: //p' "$5" | head -n1)
case "$name" in
${cases}
  *) echo "no fixture for $name" >&2; exit 2 ;;
esac
`;
}

// Runs the real entrypoint with a fake `gcx` on PATH, so the I/O shell is exercised
// without Grafana access.
function runSmokeEntrypoint(gcx: FakeGcx, env: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "smoke-run-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const fake = join(bin, "gcx");
  writeFileSync(fake, fakeGcxScript(gcx));
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
      SM_ACTION_WORKSPACE: fixtures,
      SM_ACTION_SMOKE_REPORT_FILE: reportFile,
      ...env,
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
    stderr: res.stderr,
    report: existsSync(reportFile) ? readFileSync(reportFile, "utf8") : undefined,
    outputs,
  };
}

const one = (gcx: FakeGcx) => runSmokeEntrypoint(gcx, { SM_ACTION_SMOKE_CHECK_FILE: web2001 });

// --- one check (smoke-check-file) ---

test("all probes succeed: exits 0, writes the report file and sets smoke-report", () => {
  const run = one({ fixture: "all-success.json" });
  assert.equal(run.status, 0);
  assert.match(run.report ?? "", /\| Probe \| Status \|/);
  assert.match(run.report ?? "", /probes passed\./);
  assert.ok(run.outputs["smoke-report"], "smoke-report output is set");
  assert.equal(readFileSync(run.outputs["smoke-report"]!, "utf8"), run.report);
});

test("a failing probe: exits 1 but still writes the report and failed-probes", () => {
  const run = one({ fixture: "one-failure.json" });
  assert.equal(run.status, 1);
  assert.match(run.report ?? "", /1 of 3 probes failed: Frankfurt=failure/);
  assert.ok(run.outputs["smoke-report"], "smoke-report output is set");
  assert.equal(run.outputs["failed-probes"], "web-2001/Frankfurt=failure");
});

test("no probe results: exits 1 and the report says so", () => {
  const run = one({ fixture: "no-probes.json" });
  assert.equal(run.status, 1);
  assert.match(run.report ?? "", /No probe results\./);
  assert.ok(run.outputs["smoke-report"], "smoke-report output is set");
});

test("gcx fails: exits 1, no report, smoke-report unset", () => {
  const run = one({ fail: true });
  assert.equal(run.status, 1);
  assert.equal(run.report, undefined);
  assert.equal(run.outputs["smoke-report"], undefined);
});

test("smoke-check-file is resolved against the workspace when relative", () => {
  const run = runSmokeEntrypoint(
    { fixture: "all-success.json" },
    { SM_ACTION_SMOKE_CHECK_FILE: "shared-job-checks/web-2001.yaml" },
  );
  assert.equal(run.status, 0);
});

// --- several checks (smoke-check-files) ---

const mixed = { SM_ACTION_SMOKE_CHECK_FILES: "shared-job-checks/web-2001.yaml\nshared-job-checks/web-200[23].yaml" };

test("several checks, all passing: exits 0, summary table, smoke-result is the first check", () => {
  const run = runSmokeEntrypoint(
    { byName: { "web-2001": "all-success.json", "web-2002": "all-success.json", "web-2003": "all-success.json" } },
    { SM_ACTION_SMOKE_CHECK_FILES: "shared-job-checks/web-200[123].yaml" },
  );
  assert.equal(run.status, 0);
  assert.match(run.report ?? "", /All 3 checks passed\./);
  assert.equal(run.outputs["failed-probes"], "");
  assert.ok(run.outputs["smoke-result"], "smoke-result output is set");
});

test("several checks, one failing: runs all, exits 1, failed-probes is prefixed by check", () => {
  const run = runSmokeEntrypoint(
    { byName: { "web-2001": "all-success.json", "web-2002": "one-failure.json", "web-2003": "all-success.json" } },
    mixed,
  );
  assert.equal(run.status, 1);
  assert.match(run.report ?? "", /\| web-2001 \|.*passed \(3 probes\)/);
  assert.match(run.report ?? "", /\| web-2002 \|.*failed: Frankfurt=failure/);
  assert.match(run.report ?? "", /\| web-2003 \|.*passed \(3 probes\)/);
  assert.match(run.report ?? "", /1 of 3 checks failed\./);
  assert.equal(run.outputs["failed-probes"], "web-2002/Frankfurt=failure");
  assert.match(run.stderr, /::error::web-2002: Frankfurt=failure/);
});

test("several checks: smoke-result and adhoc-id point at the first failing check", () => {
  const run = runSmokeEntrypoint(
    { byName: { "web-2001": "all-success.json", "web-2002": "one-failure.json", "web-2003": "all-success.json" } },
    mixed,
  );
  const result = JSON.parse(readFileSync(run.outputs["smoke-result"]!, "utf8")) as { probes: { status: string }[] };
  assert.ok(result.probes.some((p) => p.status === "failure"));
  const failing = JSON.parse(readFileSync(join(fixtures, "smoke", "one-failure.json"), "utf8")) as { adhoc_id: string };
  assert.equal(run.outputs["adhoc-id"], failing.adhoc_id);
});

// --- input validation ---

test("setting both smoke-check-file and smoke-check-files fails", () => {
  const run = runSmokeEntrypoint(
    { fixture: "all-success.json" },
    { SM_ACTION_SMOKE_CHECK_FILE: web2001, SM_ACTION_SMOKE_CHECK_FILES: "shared-job-checks/*.yaml" },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /only one of/i);
});

test("setting neither input fails", () => {
  const run = runSmokeEntrypoint({ fixture: "all-success.json" }, {});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /SM_ACTION_SMOKE_CHECK_FILE/);
});

test("a pattern that matches nothing fails before gcx runs", () => {
  const run = runSmokeEntrypoint({ fail: true }, { SM_ACTION_SMOKE_CHECK_FILES: "shared-job-checks/nope-*.yaml" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /nope-\*\.yaml.*no files/);
  assert.doesNotMatch(run.stderr, /gcx: boom/);
});
