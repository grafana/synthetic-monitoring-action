import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckDoc, parseCheckDocs } from "./checks-data.js";
import { type CheckChange, planSync } from "./sync-plan.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function loadDir(dir: string): CheckDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => parseCheckDocs(readFileSync(join(dir, f), "utf8")));
}

function clone(docs: CheckDoc[]): CheckDoc[] {
  return structuredClone(docs);
}

function kinds(changes: CheckChange[]): Record<string, string> {
  return Object.fromEntries(changes.map((c) => [c.name, c.kind]));
}

// All four checks share job "web" — the case that a job-keyed match collapses.
test("checks sharing a job are matched by metadata.name", () => {
  const desired = loadDir(join(fixtures, "shared-job-checks"));
  const live = clone(desired);
  live.find((d) => d.metadata.name === "web-2002")!.spec.target = "http://old.grafana.com";

  const changes = planSync(desired, live);

  assert.deepEqual(kinds(changes), {
    "web-2001": "unchanged",
    "web-2002": "update",
    "web-2003": "unchanged",
    "web-2004": "unchanged",
  });
  const update = changes.find((c) => c.kind === "update")!;
  assert.equal(update.live!.metadata.name, "web-2002");
});

test("live check missing from a shared-job source is removed-from-source", () => {
  const live = loadDir(join(fixtures, "shared-job-checks"));
  const desired = clone(live).filter((d) => d.metadata.name !== "web-2003");

  const changes = planSync(desired, live);

  assert.equal(kinds(changes)["web-2003"], "removed-from-source");
  assert.equal(changes.filter((c) => c.kind !== "unchanged").length, 1);
});

test("existing fixtures: new check is created, dropped check is removed-from-source", () => {
  const desired = loadDir(join(fixtures, "desired-checks"));
  const live = parseCheckDocs(readFileSync(join(fixtures, "checks.yaml"), "utf8"));

  const changes = planSync(desired, live);

  const k = kinds(changes);
  assert.equal(k["password-reset-browser"], "create");
  assert.equal(k["mail-tls-1004"], "removed-from-source");
});

test("unknown name falls back to a unique job", () => {
  const live = loadDir(join(fixtures, "desired-checks")).filter((d) => d.spec.job === "api-health");
  const desired = clone(live);
  desired[0].metadata.name = "api-health";
  desired[0].spec.frequency = 30000;

  const changes = planSync(desired, live);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "update");
  assert.equal(changes[0].live!.metadata.name, "api-health-1001");
});

test("unknown name with a job shared by several live checks throws", () => {
  const live = loadDir(join(fixtures, "shared-job-checks"));
  const desired = clone(live).slice(0, 1);
  desired[0].metadata.name = "web";

  assert.throws(() => planSync(desired, live), /ambiguous/);
});

test("two desired checks resolving to the same live check throws", () => {
  const live = loadDir(join(fixtures, "desired-checks")).filter((d) => d.spec.job === "api-health");
  const desired = [...clone(live), ...clone(live)];
  desired[1].metadata.name = "api-health";

  assert.throws(() => planSync(desired, live), /more than one desired check/);
});
