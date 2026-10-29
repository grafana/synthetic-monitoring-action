import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CheckDoc, parseCheckDocs } from "./checks-data.js";

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

export interface SmokePlan {
  check: CheckDoc;
  /** Overrides that couldn't apply to this check, to surface in the report. */
  notes: string[];
}

// The overrides only make sense for HTTP checks, so a mixed set (HTTP + DNS + scripted)
// can share one set of options. Other checks run as written and say so, instead of
// failing the whole run. The catch: a DNS check "passes" without proving it saw the new
// build, hence the note.
export function planSmokeCheck(doc: CheckDoc, opts: SmokeOptions): SmokePlan {
  if (doc.spec.settings.http) return { check: buildSmokeCheck(doc, opts), notes: [] };

  const skipped = [
    opts.target && "smoke-target",
    opts.cacheBust && "smoke-cache-bust",
    opts.bodyRegexp && "smoke-body-regexp",
  ].filter((o): o is string => Boolean(o));
  const notes = skipped.length
    ? [`${doc.metadata.name} is not an HTTP check; ran as written, without ${skipped.join(", ")}.`]
    : [];
  return { check: buildSmokeCheck(doc, {}), notes };
}

const GLOB_CHARS = /[*?[\]{}()!]/;

// Expands paths/globs (relative to cwd) into the checks they name. A pattern that matches
// nothing is an error: it's nearly always a typo, and silently smoke-testing less than
// intended is the worst outcome for a gate. Each file holds exactly one check.
export function resolveSmokeChecks(patterns: string[], cwd: string): CheckDoc[] {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches = GLOB_CHARS.test(pattern)
      ? globSync(pattern, { cwd })
      : existsSync(resolve(cwd, pattern))
        ? [pattern]
        : [];
    if (matches.length === 0) throw new Error(`smoke check pattern "${pattern}" matched no files (in ${cwd})`);
    for (const m of matches) files.add(m);
  }

  const byName = new Map<string, string>();
  const docs: CheckDoc[] = [];
  for (const file of [...files].sort()) {
    const found = parseCheckDocs(readFileSync(resolve(cwd, file), "utf8"));
    if (found.length !== 1) throw new Error(`${file} must contain exactly one check, found ${found.length}`);
    const doc = found[0]!;
    const other = byName.get(doc.metadata.name);
    if (other) throw new Error(`duplicate check name "${doc.metadata.name}" in ${other} and ${file}`);
    byName.set(doc.metadata.name, file);
    docs.push(doc);
  }
  return docs;
}

// `checks test` exits 0 even when probes fail, so pass/fail is decided here. No probe
// results at all counts as a failure: nothing proved the target works.
export function evaluateProbes(result: CheckTestResult): SmokeEvaluation {
  const failed = result.probes.filter((p) => p.status !== "success").map((p) => `${p.probeName}=${p.status}`);
  const total = result.probes.length;
  return { passed: total > 0 && failed.length === 0, total, failed };
}

const TITLE = "Synthetic Monitoring Smoke Test";

function heading(name: string, level = 2): string {
  return `${"#".repeat(level)} ${TITLE}: \`${name}\``;
}

export function formatSmokeReport(name: string, result: CheckTestResult, level = 2): string {
  const evaluation = evaluateProbes(result);
  const lines = [heading(name, level), "", `Target: ${result.target}`, ""];

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
  checks: CheckDoc[];
  options: SmokeOptions;
  /** Poll each distinct HTTP target before running anything; skipped when absent. */
  wait?: { timeoutMs: number; intervalMs: number };
  runCheckTest: (doc: CheckDoc) => CheckTestResult;
  waitFn?: (url: string, regexp: string | undefined, opts: WaitOptions) => Promise<boolean>;
}

export interface SmokeOutcome {
  name: string;
  /** What was sent to the probes, after overrides. */
  target: string;
  notes: string[];
  result: CheckTestResult;
  evaluation: SmokeEvaluation;
}

export interface RunSmokeOutput {
  report: string;
  /** Every check ran and every probe of every check succeeded. */
  passed: boolean;
  /** Empty when a wait timed out and nothing ran. */
  outcomes: SmokeOutcome[];
  /** Targets that never became ready; set only when nothing ran. */
  notReady?: string[];
}

function isHttpUrl(target: string): boolean {
  if (!URL.canParse(target)) return false;
  const { protocol } = new URL(target);
  return protocol === "http:" || protocol === "https:";
}

function resultCell(e: SmokeEvaluation): string {
  if (e.total === 0) return "failed: no probe results";
  return e.passed ? `passed (${e.total} probes)` : `failed: ${e.failed.join(", ")}`;
}

// One check keeps the plain per-check report. Several get a summary table first, then a
// section per check.
function formatReport(outcomes: SmokeOutcome[]): string {
  if (outcomes.length === 1) {
    const [o] = outcomes as [SmokeOutcome];
    return [formatSmokeReport(o.name, o.result), ...o.notes.map((n) => `\nNote: ${n}`)].join("\n");
  }

  const failed = outcomes.filter((o) => !o.evaluation.passed).length;
  const lines = [`## ${TITLE}`, "", "| Check | Target | Result |", "|---|---|---|"];
  for (const o of outcomes) lines.push(`| ${o.name} | ${o.target} | ${resultCell(o.evaluation)} |`);
  lines.push("", failed ? `${failed} of ${outcomes.length} checks failed.` : `All ${outcomes.length} checks passed.`);

  const notes = outcomes.flatMap((o) => o.notes);
  if (notes.length) lines.push("", ...notes.map((n) => `- ${n}`));
  for (const o of outcomes) lines.push("", formatSmokeReport(o.name, o.result, 3));
  return lines.join("\n");
}

function formatNotReady(checks: CheckDoc[], notReady: string[], timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  if (checks.length === 1) {
    return [
      heading(checks[0]!.metadata.name),
      "",
      `Target ${notReady[0]} was not ready after ${seconds}s; the check was not run.`,
    ].join("\n");
  }
  return [`## ${TITLE}`, "", `Not ready after ${seconds}s, so no checks were run:`, ...notReady.map((t) => `- ${t}`)].join(
    "\n",
  );
}

export async function runSmoke(input: RunSmokeInput): Promise<RunSmokeOutput> {
  if (input.checks.length === 0) throw new Error("no checks to smoke test");
  const plans = input.checks.map((c) => planSmokeCheck(c, input.options));

  if (input.wait) {
    const waitFn = input.waitFn ?? waitForBody;
    const wait = input.wait;
    // Checks sharing a target share one wait; non-HTTP checks have nothing to poll.
    const targets = [
      ...new Set(
        plans
          .filter((p) => p.check.spec.settings.http)
          .map((p) => p.check.spec.target)
          .filter(isHttpUrl),
      ),
    ];
    const ready = await Promise.all(
      targets.map(async (target) => ({ target, ok: await waitFn(target, input.options.bodyRegexp, wait) })),
    );
    const notReady = ready.filter((r) => !r.ok).map((r) => r.target);
    if (notReady.length > 0) {
      return {
        report: formatNotReady(input.checks, notReady, wait.timeoutMs),
        passed: false,
        outcomes: [],
        notReady,
      };
    }
  }

  const outcomes = plans.map((p): SmokeOutcome => {
    const result = input.runCheckTest(p.check);
    return {
      name: p.check.metadata.name,
      target: p.check.spec.target,
      notes: p.notes,
      result,
      evaluation: evaluateProbes(result),
    };
  });
  return { report: formatReport(outcomes), passed: outcomes.every((o) => o.evaluation.passed), outcomes };
}
