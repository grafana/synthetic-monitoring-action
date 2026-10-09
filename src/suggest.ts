import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { createModels, Model } from "@earendil-works/pi-ai";
import { getPrDiffTool, getSmChecksTool } from "./tools.js";

export interface CheckSuggestion {
  flow: string;
  checkType: "http" | "browser" | "scripted" | "multihttp";
  target: string;
  reason: string;
}

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/, "")
    .replace(/```$/, "")
    .trim();
}

function isCheckSuggestion(value: unknown): value is CheckSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.flow === "string" && typeof v.checkType === "string" && typeof v.target === "string" && typeof v.reason === "string"
  );
}

function parseSuggestions(text: string): CheckSuggestion[] {
  try {
    const parsed: unknown = JSON.parse(stripJsonFences(text));
    return Array.isArray(parsed) ? parsed.filter(isCheckSuggestion) : [];
  } catch {
    return [];
  }
}

// Runs one prompt to completion on a fresh Agent and returns its full assistant text,
// instead of streaming — both passes here produce a single JSON payload the next step
// parses, not incremental output for a human to watch.
async function runOneShot(
  models: ReturnType<typeof createModels>,
  model: Model<any>,
  systemPrompt: string,
  prompt: string,
  tools: AgentTool[],
): Promise<string> {
  const agent = new Agent({
    initialState: { systemPrompt, model, tools },
    streamFn: models.streamSimple.bind(models),
  });

  let text = "";
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  try {
    await agent.prompt(prompt);
  } finally {
    unsubscribe();
  }
  return text;
}

const PROPOSE_SYSTEM_PROMPT = `You help a team notice when a pull request introduces a user-facing flow or API
endpoint that looks important enough to deserve its own Grafana Synthetic Monitoring check, but doesn't have
one yet.

You have two tools:
- get_pr_diff: the unified diff of the pull request under review.
- get_sm_checks: every SM check already configured (so you don't suggest something already covered).

Call both tools. Then look for genuinely new or significantly changed flows: a new page/route, a new critical
button/form, a new API endpoint, a new auth or payment step. Do NOT suggest a check for internal refactors,
copy/style changes, config, tests, or anything that doesn't introduce a new externally-observable behavior.
Only suggest something if it is NOT already covered by an existing check's target/job.

Respond with ONLY a JSON array, no prose, no markdown fences, of objects shaped like:
[{"flow": "short name", "checkType": "http"|"browser"|"scripted"|"multihttp", "target": "URL or short description", "reason": "one sentence"}]
Respond with an empty array [] if nothing in this diff warrants a new check.`;

const JUDGE_SYSTEM_PROMPT = `You are an experienced SRE reviewing a first-pass list of candidate new Synthetic
Monitoring checks proposed for a pull request. Your job is to prevent check/alert fatigue: keep only
suggestions a careful team would actually act on.

Remove any candidate that is speculative, low-value, duplicates another candidate, or isn't really a
distinct user-facing flow (e.g. a second button on an already-covered page). Keep only flows whose failure
would mean real customer impact (auth, checkout/payment, core business action, data loss).

Respond with ONLY a JSON array, no prose, no markdown fences, of the candidates you kept, in the same shape
you were given. Respond with an empty array [] if none survive review.`;

// Discover -> judge, mirroring cloud-setup's authoring.ts: a first pass proposes from
// real evidence (the diff + current checks), a second, tool-less pass applies a
// skeptical review before anything reaches the PR comment. Falls back to the raw
// candidates (rather than losing them) if the judge call itself fails.
export async function suggestNewChecks(models: ReturnType<typeof createModels>, model: Model<any>): Promise<CheckSuggestion[]> {
  const proposed = parseSuggestions(
    await runOneShot(
      models,
      model,
      PROPOSE_SYSTEM_PROMPT,
      "Review this pull request and the currently configured SM checks, then propose any new checks worth adding.",
      [getPrDiffTool, getSmChecksTool],
    ),
  );
  if (proposed.length === 0) return [];

  try {
    return parseSuggestions(
      await runOneShot(
        models,
        model,
        JUDGE_SYSTEM_PROMPT,
        `Candidate checks: ${JSON.stringify(proposed)}`,
        [],
      ),
    );
  } catch {
    return proposed;
  }
}
