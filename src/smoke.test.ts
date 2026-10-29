import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckDoc, parseCheckDocs } from "./checks-data.js";
import {
  type CheckTestResult,
  buildSmokeCheck,
  evaluateProbes,
  formatSmokeReport,
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

// --- runSmoke ---

test("runSmoke runs the built check and reports a pass", async () => {
  let ran: CheckDoc | undefined;
  const out = await runSmoke({
    check: httpCheck(),
    options: { cacheBust: "abc1234" },
    runCheckTest: (doc) => {
      ran = doc;
      return loadResult("all-success.json");
    },
  });
  assert.equal(ran!.spec.target, "https://grafana.com/?cb=abc1234");
  assert.equal(out.evaluation.passed, true);
  assert.match(out.report, /All 3 probes passed/);
});

test("runSmoke waits on the smoke target before running the check", async () => {
  const waited: string[] = [];
  const out = await runSmoke({
    check: httpCheck(),
    options: { cacheBust: "abc1234", bodyRegexp: "abc1234" },
    wait: { timeoutMs: 1000, intervalMs: 100 },
    waitFn: async (url, re) => {
      waited.push(`${url} ${re}`);
      return true;
    },
    runCheckTest: () => loadResult("all-success.json"),
  });
  assert.deepEqual(waited, ["https://grafana.com/?cb=abc1234 abc1234"]);
  assert.equal(out.evaluation.passed, true);
});

test("runSmoke fails without running the check when the wait times out", async () => {
  let ran = false;
  const out = await runSmoke({
    check: httpCheck(),
    options: {},
    wait: { timeoutMs: 1000, intervalMs: 100 },
    waitFn: async () => false,
    runCheckTest: () => {
      ran = true;
      return loadResult("all-success.json");
    },
  });
  assert.equal(ran, false);
  assert.equal(out.evaluation.passed, false);
  assert.equal(out.result, undefined);
  assert.match(out.report, /not ready after 1s/);
});
