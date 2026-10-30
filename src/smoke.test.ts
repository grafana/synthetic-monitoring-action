import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { type CheckDoc, parseCheckDocs } from "./checks-data.js";
import {
  type CheckTestResult,
  buildSmokeCheck,
  evaluateProbes,
  formatSmokeReport,
  planSmokeCheck,
  resolveSmokeChecks,
  runSmoke,
  waitForBody,
} from "./smoke.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function loadCheck(file: string): CheckDoc {
  return parseCheckDocs(readFileSync(join(fixtures, "shared-job-checks", file), "utf8"))[0]!;
}

function loadResult(file: string): CheckTestResult {
  return JSON.parse(readFileSync(join(fixtures, "smoke", file), "utf8")) as CheckTestResult;
}

const httpCheck = () => loadCheck("web-2001.yaml");
const dnsCheck = () => loadCheck("web-2003.yaml");

// --- buildSmokeCheck ---

test("buildSmokeCheck leaves the check as-is without options", () => {
  const doc = httpCheck();
  assert.deepEqual(buildSmokeCheck(doc, {}), doc);
});

test("buildSmokeCheck overrides the target", () => {
  const smoke = buildSmokeCheck(httpCheck(), { target: "https://preview.grafana.com/" });
  assert.equal(smoke.spec.target, "https://preview.grafana.com/");
});

test("buildSmokeCheck adds a cb query param", () => {
  const smoke = buildSmokeCheck(httpCheck(), { cacheBust: "abc1234" });
  assert.equal(smoke.spec.target, "https://grafana.com/?cb=abc1234");
});

test("buildSmokeCheck keeps an existing query string when cache-busting", () => {
  const smoke = buildSmokeCheck(httpCheck(), { target: "https://grafana.com/docs?lang=en", cacheBust: "abc1234" });
  assert.equal(smoke.spec.target, "https://grafana.com/docs?lang=en&cb=abc1234");
});

test("buildSmokeCheck appends the body regexp to existing ones", () => {
  const doc = httpCheck();
  (doc.spec.settings.http as Record<string, unknown>).failIfBodyNotMatchesRegexp = ["Grafana"];
  const smoke = buildSmokeCheck(doc, { bodyRegexp: "build-sha" });
  assert.deepEqual((smoke.spec.settings.http as Record<string, unknown>).failIfBodyNotMatchesRegexp, [
    "Grafana",
    "build-sha",
  ]);
});

test("buildSmokeCheck does not mutate its input", () => {
  const doc = httpCheck();
  const before = structuredClone(doc);
  buildSmokeCheck(doc, { target: "https://x.grafana.com", cacheBust: "abc", bodyRegexp: "re" });
  assert.deepEqual(doc, before);
});

test("buildSmokeCheck rejects a body regexp on a non-HTTP check", () => {
  assert.throws(() => buildSmokeCheck(dnsCheck(), { bodyRegexp: "re" }), /HTTP/);
});

test("buildSmokeCheck rejects cache-busting a non-URL target", () => {
  assert.throws(() => buildSmokeCheck(dnsCheck(), { cacheBust: "abc" }), /URL/);
});

test("buildSmokeCheck rejects cache-busting a host:port target", () => {
  const doc = dnsCheck();
  doc.spec.target = "grafana.com:443";
  assert.throws(() => buildSmokeCheck(doc, { cacheBust: "abc" }), /URL/);
});

// --- evaluateProbes ---

test("evaluateProbes passes when every probe succeeds", () => {
  assert.deepEqual(evaluateProbes(loadResult("all-success.json")), { passed: true, total: 3, failed: [] });
});

test("evaluateProbes fails on a probe failure", () => {
  assert.deepEqual(evaluateProbes(loadResult("one-failure.json")), {
    passed: false,
    total: 3,
    failed: ["Frankfurt=failure"],
  });
});

test("evaluateProbes treats a timeout as a failure", () => {
  assert.deepEqual(evaluateProbes(loadResult("one-timeout.json")).failed, ["NorthCalifornia=timeout"]);
});

test("evaluateProbes fails when there are no probe results", () => {
  assert.deepEqual(evaluateProbes(loadResult("no-probes.json")), { passed: false, total: 0, failed: [] });
});

// --- formatSmokeReport ---

test("formatSmokeReport renders a probe table and verdict", () => {
  const report = formatSmokeReport("web-2001", loadResult("one-failure.json"));
  assert.match(report, /^## Synthetic Monitoring Smoke Test: `web-2001`/);
  assert.match(report, /\| Frankfurt \| failure \|/);
  assert.match(report, /1 of 3 probes failed: Frankfurt=failure/);
});

test("formatSmokeReport says so when there are no probe results", () => {
  assert.match(formatSmokeReport("web-2001", loadResult("no-probes.json")), /No probe results/);
});

// --- waitForBody ---

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function fakeFetch(bodies: (string | Error)[]) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const next = bodies.length > 1 ? bodies.shift()! : bodies[0]!;
    if (next instanceof Error) throw next;
    return { ok: true, text: async () => next };
  };
  return { fn, calls };
}

test("waitForBody returns once the body matches", async () => {
  const fetch = fakeFetch(["old", new Error("ECONNRESET"), '<meta name="build-sha" content="abc1234">']);
  const ok = await waitForBody("https://grafana.com/?cb=abc1234", "build-sha\"? content=\"?abc1234", {
    timeoutMs: 60_000,
    intervalMs: 10_000,
    fetchFn: fetch.fn,
    ...fakeClock(),
  });
  assert.equal(ok, true);
  assert.equal(fetch.calls.length, 3);
});

test("waitForBody gives up after the timeout", async () => {
  const fetch = fakeFetch(["old"]);
  const ok = await waitForBody("https://grafana.com/", "abc1234", {
    timeoutMs: 30_000,
    intervalMs: 10_000,
    fetchFn: fetch.fn,
    ...fakeClock(),
  });
  assert.equal(ok, false);
  assert.equal(fetch.calls.length, 4); // t=0, 10s, 20s, 30s
});

test("waitForBody without a regexp waits for any OK response", async () => {
  const fetch = fakeFetch([new Error("ENOTFOUND"), "anything"]);
  const ok = await waitForBody("https://grafana.com/", undefined, {
    timeoutMs: 60_000,
    intervalMs: 10_000,
    fetchFn: fetch.fn,
    ...fakeClock(),
  });
  assert.equal(ok, true);
});

// --- planSmokeCheck ---

const scriptedCheck = () => loadCheck("web-2004.yaml");

test("planSmokeCheck applies every override to an HTTP check", () => {
  const opts = { target: "https://preview.grafana.com/", cacheBust: "abc", bodyRegexp: "re" };
  const plan = planSmokeCheck(httpCheck(), opts);
  assert.deepEqual(plan.check, buildSmokeCheck(httpCheck(), opts));
  assert.deepEqual(plan.notes, []);
});

test("planSmokeCheck runs a DNS check unmodified and says which overrides it skipped", () => {
  const plan = planSmokeCheck(dnsCheck(), { target: "https://x.grafana.com/", cacheBust: "abc", bodyRegexp: "re" });
  assert.deepEqual(plan.check, dnsCheck());
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0]!, /web-2003/);
  assert.match(plan.notes[0]!, /smoke-target, smoke-cache-bust, smoke-body-regexp/);
});

test("planSmokeCheck only names the overrides that were actually set", () => {
  const plan = planSmokeCheck(scriptedCheck(), { bodyRegexp: "re" });
  assert.deepEqual(plan.check, scriptedCheck());
  assert.match(plan.notes[0]!, /smoke-body-regexp/);
  assert.doesNotMatch(plan.notes[0]!, /smoke-target|smoke-cache-bust/);
});

test("planSmokeCheck has nothing to say about a non-HTTP check without overrides", () => {
  assert.deepEqual(planSmokeCheck(dnsCheck(), {}).notes, []);
});

// --- resolveSmokeChecks ---

const names = (docs: CheckDoc[]) => docs.map((d) => d.metadata.name);

test("resolveSmokeChecks expands globs, sorted", () => {
  assert.deepEqual(names(resolveSmokeChecks(["shared-job-checks/web-200*.yaml"], fixtures)), [
    "web-2001",
    "web-2002",
    "web-2003",
    "web-2004",
  ]);
});

test("resolveSmokeChecks de-dupes files matched by several patterns", () => {
  const docs = resolveSmokeChecks(["shared-job-checks/web-2001.yaml", "shared-job-checks/web-200[12].yaml"], fixtures);
  assert.deepEqual(names(docs), ["web-2001", "web-2002"]);
});

test("resolveSmokeChecks fails on a pattern that matches nothing", () => {
  assert.throws(() => resolveSmokeChecks(["shared-job-checks/nope-*.yaml"], fixtures), /nope-\*\.yaml.*no files/);
});

function tempChecks(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-resolve-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const checkYaml = (name: string) => readFileSync(join(fixtures, "shared-job-checks", "web-2001.yaml"), "utf8").replace("web-2001", name);

test("resolveSmokeChecks fails on a file that doesn't hold exactly one check", () => {
  const two = YAML.stringify([YAML.parse(checkYaml("a")), YAML.parse(checkYaml("b"))]);
  const dir = tempChecks({ "two.yaml": two, "none.yaml": "foo: bar\n" });
  assert.throws(() => resolveSmokeChecks(["two.yaml"], dir), /two\.yaml.*exactly one check, found 2/);
  assert.throws(() => resolveSmokeChecks(["none.yaml"], dir), /none\.yaml.*exactly one check, found 0/);
});

test("resolveSmokeChecks fails when two files define the same check name", () => {
  const dir = tempChecks({ "a.yaml": checkYaml("same"), "b.yaml": checkYaml("same") });
  assert.throws(() => resolveSmokeChecks(["*.yaml"], dir), /duplicate check name "same"/);
});

// --- runSmoke ---

const resultsByName: Record<string, string> = {
  "web-2001": "all-success.json",
  "web-2002": "one-failure.json",
  "web-2003": "all-success.json",
};

const runByName = (doc: CheckDoc) => loadResult(resultsByName[doc.metadata.name] ?? "all-success.json");

test("runSmoke runs the built check and reports a pass", async () => {
  let ran: CheckDoc | undefined;
  const out = await runSmoke({
    checks: [httpCheck()],
    options: { cacheBust: "abc1234" },
    runCheckTest: (doc) => {
      ran = doc;
      return loadResult("all-success.json");
    },
  });
  assert.equal(ran!.spec.target, "https://grafana.com/?cb=abc1234");
  assert.equal(out.passed, true);
  assert.match(out.report, /All 3 probes passed/);
});

test("runSmoke with one check reports exactly what formatSmokeReport does", async () => {
  const out = await runSmoke({ checks: [httpCheck()], options: {}, runCheckTest: () => loadResult("one-failure.json") });
  assert.equal(out.report, formatSmokeReport("web-2001", loadResult("one-failure.json")));
  assert.equal(out.passed, false);
});

test("runSmoke waits on the smoke target before running the check", async () => {
  const waited: string[] = [];
  const out = await runSmoke({
    checks: [httpCheck()],
    options: { cacheBust: "abc1234", bodyRegexp: "abc1234" },
    wait: { timeoutMs: 1000, intervalMs: 100 },
    waitFn: async (url, re) => {
      waited.push(`${url} ${re}`);
      return true;
    },
    runCheckTest: () => loadResult("all-success.json"),
  });
  assert.deepEqual(waited, ["https://grafana.com/?cb=abc1234 abc1234"]);
  assert.equal(out.passed, true);
});

test("runSmoke fails without running the check when the wait times out", async () => {
  let ran = false;
  const out = await runSmoke({
    checks: [httpCheck()],
    options: {},
    wait: { timeoutMs: 1000, intervalMs: 100 },
    waitFn: async () => false,
    runCheckTest: () => {
      ran = true;
      return loadResult("all-success.json");
    },
  });
  assert.equal(ran, false);
  assert.equal(out.passed, false);
  assert.deepEqual(out.outcomes, []);
  assert.deepEqual(out.notReady, ["https://grafana.com"]);
  assert.match(out.report, /not ready after 1s/);
});

test("runSmoke runs every check even when one fails, and fails overall", async () => {
  const ran: string[] = [];
  const out = await runSmoke({
    checks: [httpCheck(), loadCheck("web-2002.yaml"), dnsCheck()],
    options: {},
    runCheckTest: (doc) => {
      ran.push(doc.metadata.name);
      return runByName(doc);
    },
  });
  assert.deepEqual(ran, ["web-2001", "web-2002", "web-2003"]);
  assert.equal(out.passed, false);
  assert.deepEqual(
    out.outcomes.map((o) => [o.name, o.evaluation.passed]),
    [
      ["web-2001", true],
      ["web-2002", false],
      ["web-2003", true],
    ],
  );
});

test("runSmoke waits once per distinct HTTP target and never for a DNS check", async () => {
  const waited: string[] = [];
  const twin = httpCheck();
  twin.metadata.name = "web-2001-twin";
  await runSmoke({
    checks: [httpCheck(), twin, loadCheck("web-2002.yaml"), dnsCheck(), scriptedCheck()],
    options: { cacheBust: "abc" },
    wait: { timeoutMs: 1000, intervalMs: 100 },
    waitFn: async (url) => {
      waited.push(url);
      return true;
    },
    runCheckTest: runByName,
  });
  assert.deepEqual(waited.sort(), ["http://grafana.com/?cb=abc", "https://grafana.com/?cb=abc"]);
});

test("runSmoke aborts without running anything if any target isn't ready", async () => {
  let ran = 0;
  const out = await runSmoke({
    checks: [httpCheck(), loadCheck("web-2002.yaml")],
    options: {},
    wait: { timeoutMs: 1000, intervalMs: 100 },
    waitFn: async (url) => url.startsWith("https"),
    runCheckTest: (doc) => {
      ran++;
      return runByName(doc);
    },
  });
  assert.equal(ran, 0);
  assert.equal(out.passed, false);
  assert.deepEqual(out.notReady, ["http://grafana.com"]);
});

test("runSmoke with several checks reports a summary table and a section per check", async () => {
  const out = await runSmoke({
    checks: [httpCheck(), loadCheck("web-2002.yaml")],
    options: {},
    runCheckTest: runByName,
  });
  assert.match(out.report, /^## Synthetic Monitoring Smoke Test\n/);
  assert.match(out.report, /\| web-2001 \| https:\/\/grafana\.com \| passed \(3 probes\) \|/);
  assert.match(out.report, /\| web-2002 \| http:\/\/grafana\.com \| failed: Frankfurt=failure \|/);
  assert.match(out.report, /1 of 2 checks failed\./);
  assert.match(out.report, /### Synthetic Monitoring Smoke Test: `web-2001`/);
  assert.match(out.report, /### Synthetic Monitoring Smoke Test: `web-2002`/);
});

test("runSmoke puts a skipped-override note in the report", async () => {
  const out = await runSmoke({
    checks: [httpCheck(), dnsCheck()],
    options: { bodyRegexp: "abc" },
    runCheckTest: runByName,
  });
  assert.match(out.report, /web-2003.*smoke-body-regexp/);
  assert.deepEqual(
    out.outcomes.map((o) => o.notes.length),
    [0, 1],
  );
});
