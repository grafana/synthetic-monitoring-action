import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { type CheckDoc, loadDesiredChecks, loadLiveChecks } from "./checks-data.js";
import { type CheckChange, formatSyncResult, planSync } from "./sync-plan.js";

function gcxWriteCheck(action: "create" | "update", doc: CheckDoc, idForUpdate?: string): void {
  const dir = mkdtempSync(join(tmpdir(), "sm-action-sync-"));
  const file = join(dir, "check.yaml");
  writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }), "utf8");

  const args =
    action === "create"
      ? ["synthetic-monitoring", "checks", "create", "-f", file]
      : ["synthetic-monitoring", "checks", "update", idForUpdate!, "-f", file];

  const result = spawnSync("gcx", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gcx ${args.join(" ")} failed: ${result.stderr || result.error}`);
  }
}

function gcxDeleteCheck(doc: CheckDoc): void {
  const result = spawnSync("gcx", ["synthetic-monitoring", "checks", "delete", doc.metadata.name, "--force"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`gcx synthetic-monitoring checks delete ${doc.metadata.name} failed: ${result.stderr || result.error}`);
  }
}

// Append-only by default: create/update apply automatically, but a check that's live
// and missing from the source is only ever deleted when force-delete is explicitly on
// (SM_ACTION_FORCE_DELETE=true) — fewer moving parts than a separate approval flow,
// at the cost of that decision being made once, in the workflow's config, rather than
// per-check by whoever happens to comment on a given PR.
function applyChanges(changes: CheckChange[], forceDelete: boolean): string[] {
  const results: string[] = [];
  for (const c of changes) {
    if (c.kind === "create") {
      gcxWriteCheck("create", c.desired!);
      results.push(`Created \`${c.job}\` (${c.desired!.spec.target})`);
    } else if (c.kind === "update") {
      gcxWriteCheck("update", c.desired!, c.live!.metadata.name);
      results.push(`Updated \`${c.job}\`: ${c.diff!.join("; ")}`);
    } else if (c.kind === "removed-from-source" && forceDelete) {
      gcxDeleteCheck(c.live!);
      results.push(`Deleted \`${c.job}\` (${c.live!.spec.target})`);
    }
  }
  return results;
}

// No separate preview mode: this always applies when it runs. Whether that means
// "on every PR" or "only after merge" is entirely down to which workflow trigger you
// attach the action to — not something configured here.
function main(): void {
  const forceDelete = process.env.SM_ACTION_FORCE_DELETE === "true";

  const desired = loadDesiredChecks();
  const live = loadLiveChecks();
  const changes = planSync(desired, live);

  const results = applyChanges(changes, forceDelete);
  const skipped = forceDelete ? [] : changes.filter((c) => c.kind === "removed-from-source");
  process.stdout.write(`${formatSyncResult(results, skipped)}\n`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
