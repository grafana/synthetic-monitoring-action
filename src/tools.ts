import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadLiveChecksYamlScoped } from "./checks-data.js";

// Full spec YAML (gcx or SM_ACTION_LIVE_CHECKS_FILE fixture), already scoped by
// SM_ACTION_LABEL_FILTER / SM_ACTION_TARGET_FILTER when set — see checks-data.ts.
// Includes the k6 script for browser/scripted checks, which is where a
// CSS/testid selector would appear.
export const getSmChecksTool: AgentTool = {
  name: "get_sm_checks",
  label: "Get Synthetic Monitoring checks",
  description:
    "Returns the full YAML definitions of every Grafana Synthetic Monitoring check currently configured " +
    "(scoped to the configured label/target filter, if any), including the k6 script source for " +
    "browser/scripted checks (which is where locators/selectors live).",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params) => {
    const yaml = loadLiveChecksYamlScoped();
    return { content: [{ type: "text", text: yaml }], details: { source: process.env.SM_ACTION_LIVE_CHECKS_FILE ?? "gcx" } };
  },
};

// Real path: `git diff` against the PR's base ref (SM_ACTION_BASE_REF, e.g.
// "origin/main" — the composite action sets this to "origin/<base-branch>" after
// fetching it). Falls back to a plain working-tree `git diff` when unset, for local,
// non-PR use. SM_ACTION_DIFF_FILE overrides both with a local fixture diff for this POC.
function loadDiff(): string {
  const fixturePath = process.env.SM_ACTION_DIFF_FILE;
  if (fixturePath) {
    return readFileSync(fixturePath, "utf8");
  }

  const baseRef = process.env.SM_ACTION_BASE_REF;
  const args = baseRef ? ["diff", `${baseRef}...HEAD`] : ["diff"];
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

export const getPrDiffTool: AgentTool = {
  name: "get_pr_diff",
  label: "Get PR diff",
  description: "Returns the unified diff of the changes under review.",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params) => {
    const diff = loadDiff();
    return { content: [{ type: "text", text: diff || "(empty diff)" }], details: { source: process.env.SM_ACTION_DIFF_FILE ?? "git diff" } };
  },
};
