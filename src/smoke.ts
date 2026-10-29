import type { CheckDoc } from "./checks-data.js";

export interface SmokeOptions {
  /** Replaces spec.target, e.g. a PR preview URL. */
  target?: string;
  /** Added as a `cb` query param so probes skip a CDN-cached copy of the page. */
  cacheBust?: string;
  /** Extra failIfBodyNotMatchesRegexp entry, e.g. this build's commit SHA. */
  bodyRegexp?: string;
}

export interface ProbeResult {
  probeName: string;
  status: string;
}

/** Shape of `gcx synthetic-monitoring checks test -o json`. */
export interface CheckTestResult {
  adhoc_id: string;
  target: string;
  probes: ProbeResult[];
}

export interface SmokeEvaluation {
  passed: boolean;
  total: number;
  /** "<probe>=<status>" for every probe that didn't report success. */
  failed: string[];
}

// Returns a copy of the check, rewritten to run once against a fresh deploy. The body
// regexp is appended rather than replacing the check's own assertions, so a smoke run
// is at least as strict as the scheduled check it's built from.
export function buildSmokeCheck(doc: CheckDoc, opts: SmokeOptions): CheckDoc {
  const smoke = structuredClone(doc);
  if (opts.target) smoke.spec.target = opts.target;

  if (opts.cacheBust) {
    // URL.canParse alone isn't enough: "host:443" parses, with "host:" as the scheme.
    const url = URL.canParse(smoke.spec.target) ? new URL(smoke.spec.target) : undefined;
    if (url?.protocol !== "http:" && url?.protocol !== "https:") {
      throw new Error(`cache-bust needs an http(s) URL target, got "${smoke.spec.target}"`);
    }
    url.searchParams.set("cb", opts.cacheBust);
    smoke.spec.target = url.toString();
  }

  if (opts.bodyRegexp) {
    const http = smoke.spec.settings.http as Record<string, unknown> | undefined;
    if (!http) {
      throw new Error(`body regexp only applies to HTTP checks; "${doc.metadata.name}" isn't one`);
    }
    const existing = (http.failIfBodyNotMatchesRegexp as string[] | undefined) ?? [];
    http.failIfBodyNotMatchesRegexp = [...existing, opts.bodyRegexp];
  }

  return smoke;
}

// `checks test` exits 0 even when probes fail, so pass/fail is decided here. No probe
// results at all counts as a failure: nothing proved the target works.
export function evaluateProbes(result: CheckTestResult): SmokeEvaluation {
  const failed = result.probes.filter((p) => p.status !== "success").map((p) => `${p.probeName}=${p.status}`);
  const total = result.probes.length;
  return { passed: total > 0 && failed.length === 0, total, failed };
}

function heading(name: string): string {
  return `## Synthetic Monitoring Smoke Test: \`${name}\``;
}

export function formatSmokeReport(name: string, result: CheckTestResult): string {
  const evaluation = evaluateProbes(result);
  const lines = [heading(name), "", `Target: ${result.target}`, ""];

  if (evaluation.total === 0) {
    lines.push("No probe results.");
    return lines.join("\n");
  }

  lines.push("| Probe | Status |", "|---|---|");
  for (const p of result.probes) lines.push(`| ${p.probeName} | ${p.status} |`);
  lines.push("");
  lines.push(
    evaluation.passed
      ? `All ${evaluation.total} probes passed.`
      : `${evaluation.failed.length} of ${evaluation.total} probes failed: ${evaluation.failed.join(", ")}`,
  );
  return lines.join("\n");
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  fetchFn?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) });
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Polls until the URL responds OK and, if given, its body matches the regexp, i.e. the
// new build is actually being served. Network errors count as "not yet". Note this
// regexp runs in JavaScript while the probe's failIfBodyNotMatchesRegexp runs in Go's
// RE2; simple patterns behave the same in both, lookarounds/backreferences don't.
export async function waitForBody(url: string, regexp: string | undefined, opts: WaitOptions): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const re = regexp ? new RegExp(regexp) : undefined;
  const deadline = now() + opts.timeoutMs;

  for (;;) {
    try {
      const res = await fetchFn(url);
      if (res.ok && (!re || re.test(await res.text()))) return true;
    } catch {
      // not reachable yet
    }
    if (now() >= deadline) return false;
    await sleep(opts.intervalMs);
  }
}

export interface RunSmokeInput {
  check: CheckDoc;
  options: SmokeOptions;
  /** Poll the smoke target before running the check; skipped when absent. */
  wait?: { timeoutMs: number; intervalMs: number };
  runCheckTest: (doc: CheckDoc) => CheckTestResult;
  waitFn?: (url: string, regexp: string | undefined, opts: WaitOptions) => Promise<boolean>;
}

export interface RunSmokeOutput {
  report: string;
  evaluation: SmokeEvaluation;
  /** Absent when the wait timed out and the check never ran. */
  result?: CheckTestResult;
}

export async function runSmoke(input: RunSmokeInput): Promise<RunSmokeOutput> {
  const smoke = buildSmokeCheck(input.check, input.options);
  const name = input.check.metadata.name;

  if (input.wait) {
    const waitFn = input.waitFn ?? waitForBody;
    const ready = await waitFn(smoke.spec.target, input.options.bodyRegexp, input.wait);
    if (!ready) {
      const report = [
        heading(name),
        "",
        `Target ${smoke.spec.target} was not ready after ${input.wait.timeoutMs / 1000}s; the check was not run.`,
      ].join("\n");
      return { report, evaluation: { passed: false, total: 0, failed: [] } };
    }
  }

  const result = input.runCheckTest(smoke);
  return { report: formatSmokeReport(name, result), evaluation: evaluateProbes(result), result };
}
