import type { CheckDoc } from "./checks-data.js";

export type ChangeKind = "create" | "update" | "unchanged" | "removed-from-source";

export interface CheckChange {
  job: string;
  /** metadata.name — the live name when matched, else the desired one. */
  name: string;
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

// Matches desired <-> live checks by metadata.name first: it's the "<job>-<id>" name
// gcx assigns once a check exists live, and a source exported from live (gcx checks
// list -o yaml) carries it. spec.job alone isn't unique — several checks can share a
// job (e.g. an http, a dns and a scripted check all under job "web"). A desired check
// whose name isn't live yet (hand-authored, never created) falls back to spec.job, but
// only when exactly one live check has that job; with several it's ambiguous which one
// is meant, so this throws rather than guess and update the wrong check or create a
// duplicate.
export function planSync(desired: CheckDoc[], live: CheckDoc[]): CheckChange[] {
  const liveByName = new Map(live.map((d) => [d.metadata.name, d]));
  const liveByJob = new Map<string, CheckDoc[]>();
  for (const l of live) liveByJob.set(l.spec.job, [...(liveByJob.get(l.spec.job) ?? []), l]);
  const matched = new Set<CheckDoc>();
  const changes: CheckChange[] = [];

  for (const d of desired) {
    let existing = liveByName.get(d.metadata.name);
    if (!existing) {
      const sameJob = liveByJob.get(d.spec.job) ?? [];
      if (sameJob.length > 1) {
        const names = sameJob.map((l) => l.metadata.name).join(", ");
        throw new Error(
          `desired check "${d.metadata.name}" isn't live and its job "${d.spec.job}" is ambiguous (live: ${names}) — set metadata.name to one of them`,
        );
      }
      existing = sameJob[0];
    }
    if (!existing) {
      changes.push({ job: d.spec.job, name: d.metadata.name, kind: "create", desired: d });
      continue;
    }
    if (matched.has(existing)) {
      throw new Error(`more than one desired check matches live check "${existing.metadata.name}"`);
    }
    matched.add(existing);
    const name = existing.metadata.name;
    const diff = diffSpecs(existing.spec, d.spec);
    changes.push(
      diff.length > 0
        ? { job: d.spec.job, name, kind: "update", desired: d, live: existing, diff }
        : { job: d.spec.job, name, kind: "unchanged", desired: d, live: existing },
    );
  }

  for (const l of live) {
    if (!matched.has(l)) {
      changes.push({ job: l.spec.job, name: l.metadata.name, kind: "removed-from-source", live: l });
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
    for (const c of skipped) lines.push(`- \`${c.job}\` (${c.name}, ${c.live!.spec.target})`);
  }

  return lines.join("\n");
}
