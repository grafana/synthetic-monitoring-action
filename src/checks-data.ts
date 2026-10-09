import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

export interface CheckLabel {
  name: string;
  value: string;
}

export interface CheckSpec {
  job: string;
  target: string;
  frequency: number;
  timeout: number;
  enabled: boolean;
  labels?: CheckLabel[];
  probes?: string[];
  alertSensitivity?: string;
  basicMetricsOnly?: boolean;
  settings: Record<string, unknown>;
}

export interface CheckDoc {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: CheckSpec;
}

export interface ScopeFilter {
  /** "key=value", comma-separated for multiple required labels (AND semantics). */
  label?: string;
  /** Substring match against spec.target — "scoped to checks hitting domain W". */
  targetContains?: string;
}

export function readScopeFilterFromEnv(): ScopeFilter {
  return {
    label: process.env.SM_ACTION_LABEL_FILTER || undefined,
    targetContains: process.env.SM_ACTION_TARGET_FILTER || undefined,
  };
}

function matchesLabelFilter(doc: CheckDoc, labelFilter: string): boolean {
  const required = labelFilter
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean);
  const labels = doc.spec.labels ?? [];
  return required.every((pair) => {
    const [key, value] = pair.split("=").map((s) => s.trim());
    return labels.some((l) => l.name === key && l.value === value);
  });
}

export function applyScopeFilter(docs: CheckDoc[], filter: ScopeFilter): CheckDoc[] {
  return docs.filter((doc) => {
    if (filter.label && !matchesLabelFilter(doc, filter.label)) return false;
    if (filter.targetContains && !doc.spec.target.includes(filter.targetContains)) return false;
    return true;
  });
}

export function isScopeFilterActive(filter: ScopeFilter): boolean {
  return Boolean(filter.label || filter.targetContains);
}

function isCheckDoc(value: unknown): value is CheckDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const metadata = v.metadata as Record<string, unknown> | undefined;
  return (
    typeof v.apiVersion === "string" &&
    typeof v.kind === "string" &&
    typeof metadata?.name === "string" &&
    typeof v.spec === "object" &&
    v.spec !== null
  );
}

export function parseCheckDocs(yamlText: string): CheckDoc[] {
  const parsed: unknown = YAML.parse(yamlText);
  if (!parsed) return [];
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  return docs.filter(isCheckDoc);
}

// yaml's default stringify folds long lines (`>` style, mid-URL wrapping) — disastrous
// for an embedded k6 script. lineWidth: 0 disables wrapping, which makes it pick literal
// block style (`|`) and preserve the script byte-for-byte instead.
export function stringifyCheckDocs(docs: CheckDoc[]): string {
  return YAML.stringify(docs, { lineWidth: 0 });
}

function loadLiveChecksYaml(): string {
  const fixturePath = process.env.SM_ACTION_LIVE_CHECKS_FILE;
  if (fixturePath) {
    return readFileSync(fixturePath, "utf8");
  }
  const result = spawnSync("gcx", ["synthetic-monitoring", "checks", "list", "-o", "yaml"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gcx synthetic-monitoring checks list failed: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

// Real path: `gcx synthetic-monitoring checks list -o yaml`. SM_ACTION_LIVE_CHECKS_FILE
// overrides this with a local fixture — for this POC (the connected stack has no
// checks to demo against yet) and for tests. Scoped by SM_ACTION_LABEL_FILTER /
// SM_ACTION_TARGET_FILTER when set.
export function loadLiveChecks(): CheckDoc[] {
  return applyScopeFilter(parseCheckDocs(loadLiveChecksYaml()), readScopeFilterFromEnv());
}

// Returns the raw YAML text when no scope filter is active (preserves exact original
// formatting for the LLM to read), and the filtered+restringified text otherwise.
export function loadLiveChecksYamlScoped(): string {
  const filter = readScopeFilterFromEnv();
  const raw = loadLiveChecksYaml();
  if (!isScopeFilterActive(filter)) return raw;
  const docs = applyScopeFilter(parseCheckDocs(raw), filter);
  return docs.length > 0 ? stringifyCheckDocs(docs) : "(no checks match the configured scope)";
}

// Desired state for the sync feature: either one big YAML file (an array of check
// docs, SM_ACTION_DESIRED_CHECKS_FILE) or one YAML file per check under a directory
// (SM_ACTION_DESIRED_CHECKS_DIR — "folder X"). Exactly one must be set.
export function loadDesiredChecks(): CheckDoc[] {
  const filePath = process.env.SM_ACTION_DESIRED_CHECKS_FILE;
  const dirPath = process.env.SM_ACTION_DESIRED_CHECKS_DIR;
  if (filePath && dirPath) {
    throw new Error("Set only one of SM_ACTION_DESIRED_CHECKS_FILE or SM_ACTION_DESIRED_CHECKS_DIR, not both.");
  }

  let docs: CheckDoc[];
  if (filePath) {
    docs = parseCheckDocs(readFileSync(filePath, "utf8"));
  } else if (dirPath) {
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    docs = files.flatMap((f) => parseCheckDocs(readFileSync(join(dirPath, f), "utf8")));
  } else {
    throw new Error("Set SM_ACTION_DESIRED_CHECKS_FILE or SM_ACTION_DESIRED_CHECKS_DIR to sync checks.");
  }

  return applyScopeFilter(docs, readScopeFilterFromEnv());
}
