import type { CheckDoc } from "./checks-data.js";

export type ChangeKind = "create" | "update" | "unchanged" | "removed-from-source";

export interface CheckChange {
  job: string;
  kind: ChangeKind;
  desired?: CheckDoc;
  live?: CheckDoc;
  /** Human-readable changed fields, present only for "update". */
  diff?: string[];
}

const COMPARABLE_FIELDS = ["target", "frequency", "timeout", "enabled", "alertSensitivity", "basicMetricsOnly"] as const;

// The live API fills in defaults a hand-authored desired-state file never specified
// (verified live: a plain `settings: { http: { method: GET } }` comes back from gcx
// as `{ method: GET, failIfNotSSL: false, failIfSSL: false, ipVersion: Any,
// noFollowRedirects: false }`). A strict equality check on `settings` would flag
// "changed" on every sync run forever. Instead, only flag it when a key the desired
// side actually specifies differs on the live side — extra server-defaulted keys
// present only in live are not a real difference. Arrays (script content, multihttp
// entries, ...) still compare exactly, since partial-subset doesn't make sense there.
function isSubset(desired: unknown, live: unknown): boolean {
  if (Array.isArray(desired) || Array.isArray(live)) {
    return JSON.stringify(desired) === JSON.stringify(live);
  }
  if (typeof desired === "object" && desired !== null && typeof live === "object" && live !== null) {
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      isSubset(value, (live as Record<string, unknown>)[key]),
    );
  }
  return desired === live;
}

function diffSpecs(live: CheckDoc["spec"], desired: CheckDoc["spec"]): string[] {
  const diff: string[] = [];
  for (const field of COMPARABLE_FIELDS) {
    if (JSON.stringify(live[field]) !== JSON.stringify(desired[field])) {
      diff.push(`${field}: ${JSON.stringify(live[field])} -> ${JSON.stringify(desired[field])}`);
    }
  }
  if (JSON.stringify(live.probes ?? []) !== JSON.stringify(desired.probes ?? [])) {
    diff.push(`probes: [${(live.probes ?? []).join(", ")}] -> [${(desired.probes ?? []).join(", ")}]`);
  }
  if (JSON.stringify(live.labels ?? []) !== JSON.stringify(desired.labels ?? [])) {
    diff.push("labels changed");
  }
  if (!isSubset(desired.settings, live.settings)) {
    diff.push("settings changed (script or check-type config differs)");
  }
  return diff;
}

// Matches desired <-> live checks by spec.job, the stable identity across the two
// sides — metadata.name is a "<job>-<id>" composite gcx assigns only once a check
// exists live, so the desired-state file can't know it in advance.
export function planSync(desired: CheckDoc[], live: CheckDoc[]): CheckChange[] {
  const liveByJob = new Map(live.map((d) => [d.spec.job, d]));
  const desiredJobs = new Set(desired.map((d) => d.spec.job));
  const changes: CheckChange[] = [];

  for (const d of desired) {
    const existing = liveByJob.get(d.spec.job);
    if (!existing) {
      changes.push({ job: d.spec.job, kind: "create", desired: d });
      continue;
    }
    const diff = diffSpecs(existing.spec, d.spec);
    changes.push(
      diff.length > 0
        ? { job: d.spec.job, kind: "update", desired: d, live: existing, diff }
        : { job: d.spec.job, kind: "unchanged", desired: d, live: existing },
    );
  }

  for (const l of live) {
    if (!desiredJobs.has(l.spec.job)) {
      changes.push({ job: l.spec.job, kind: "removed-from-source", live: l });
    }
  }

  return changes;
}

// Single report of what actually happened — sync always applies when it runs (no
// separate preview mode; attach it to whichever workflow trigger you want it to act
// on). `skipped` is the "removed-from-source" checks that weren't touched because
// force-delete is off — reported for visibility, not as a pending action.
export function formatSyncResult(results: string[], skipped: CheckChange[]): string {
  const lines = ["## Synthetic Monitoring Sync", ""];

  if (results.length === 0 && skipped.length === 0) {
    lines.push("No changes — live checks already match the source.");
    return lines.join("\n");
  }

  for (const r of results) lines.push(`- ${r}`);

  if (skipped.length > 0) {
    if (results.length > 0) lines.push("");
    lines.push(`${skipped.length} check(s) exist live but aren't in the source (not deleted — force-delete is off):`);
    for (const c of skipped) lines.push(`- \`${c.job}\` (${c.live!.spec.target})`);
  }

  return lines.join("\n");
}
