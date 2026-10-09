import { appendFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { parseVerdict } from "./report.js";
import { type CheckSuggestion, suggestNewChecks } from "./suggest.js";
import { getPrDiffTool, getSmChecksTool } from "./tools.js";

const IMPACT_SYSTEM_PROMPT = `You are a CI assistant that protects Grafana Synthetic Monitoring checks from being
silently broken by application pull requests.

You have two tools:
- get_sm_checks: the full YAML of every currently configured SM check (apiVersion/kind/
  metadata/spec), covering every check type: http, ping, dns, tcp, traceroute, grpc
  (no script — just target/settings), multihttp (a request sequence with checks/
  variables), scripted (a k6 script using http.* and expect()), and browser (a k6
  script using page.* locators and expect()).
- get_pr_diff: the unified diff of the pull request under review.

Call both tools, then reason carefully about what each check type actually depends on,
and whether the diff changes exactly that:
- browser checks: every selector/locator (data-testid, getByRole name, getByLabel,
  getByText) and visible text string the script interacts with or asserts on.
- scripted checks: every JSON response field the script reads (e.g. \`.json('token')\`)
  and every status code it asserts with expect().
- multihttp checks: every JSON path in a \`variables\` expression (e.g. \`$.token\`) and
  every status code/value in a \`checks\` assertion.
- http checks: whether the diff changes the status code, body shape, or TLS behavior
  of the specific endpoint in \`target\`.
- ping/dns/tcp/traceroute/grpc checks: these have no script and depend only on the
  target host/port/record resolving — a pure frontend or application-logic diff almost
  never affects them.

Do not flag a check just because a file with a similar-sounding name was touched —
only flag it when the diff actually changes the specific field, selector, status code,
or text that check's definition depends on.

Respond with a short report in this exact shape:

## SM Check Impact Report

For each check, one line: "<job name>: AFFECTED - <reason>" or "<job name>: OK".
Then a one-line verdict: "N of M checks potentially affected." or "No checks appear affected."`;

async function runImpactCheck(models: ReturnType<typeof createModels>, model: Model<any>): Promise<string> {
  const agent = new Agent({
    initialState: {
      systemPrompt: IMPACT_SYSTEM_PROMPT,
      model,
      tools: [getSmChecksTool, getPrDiffTool],
    },
    streamFn: models.streamSimple.bind(models),
  });

  let report = "";
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.error(`[tool] ${event.toolName}...`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      report += event.assistantMessageEvent.delta;
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await agent.prompt(
    "Analyze this pull request for impact on existing Synthetic Monitoring checks. " +
      "Use your tools to fetch the current checks and the PR diff, then produce the report.",
  );
  process.stdout.write("\n");
  return report;
}

function formatSuggestions(suggestions: CheckSuggestion[]): string {
  if (suggestions.length === 0) {
    return "## Suggested New Checks\n\nNo new checks suggested for this PR.";
  }
  const lines = suggestions.map((s) => `- **${s.flow}** (${s.checkType}) — ${s.reason} _(target: ${s.target})_`);
  return ["## Suggested New Checks", "", ...lines].join("\n");
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  const checkImpact = process.env.SM_ACTION_CHECK_IMPACT !== "false"; // default on
  const suggestChecks = process.env.SM_ACTION_SUGGEST_CHECKS === "true"; // default off
  if (!checkImpact && !suggestChecks) {
    throw new Error("Both SM_ACTION_CHECK_IMPACT and SM_ACTION_SUGGEST_CHECKS are disabled — nothing to do.");
  }

  const models = createModels();
  models.setProvider(anthropicProvider());

  const modelId = process.env.SM_ACTION_MODEL_ID ?? "claude-sonnet-5-5";
  const model = models.getModel("anthropic", modelId);
  if (!model) {
    const available = models.getModels("anthropic").map((m) => m.id);
    throw new Error(`Model "${modelId}" not found. Available anthropic models: ${available.join(", ")}`);
  }

  // runImpactCheck streams its report to stdout live as it generates; the suggestions
  // pass produces one parsed JSON result instead, so it's printed once, after.
  let impactReport: string | undefined;
  if (checkImpact) {
    impactReport = await runImpactCheck(models, model);
  }

  if (suggestChecks) {
    console.error("[suggest] analyzing diff for missing check coverage...");
    const suggestions = await suggestNewChecks(models, model);
    const formatted = formatSuggestions(suggestions);
    process.stdout.write(`${impactReport ? "\n" : ""}${formatted}\n`);
  }

  if (impactReport) {
    const verdict = parseVerdict(impactReport);
    console.error(`[verdict] ${verdict.affectedCount} of ${verdict.totalCount} checks affected`);

    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      appendFileSync(outputFile, `affected-count=${verdict.affectedCount}\n`);
      appendFileSync(outputFile, `total-count=${verdict.totalCount}\n`);
    }

    const failOnAffected = process.env.SM_ACTION_FAIL_ON_AFFECTED === "true";
    if (failOnAffected && verdict.affectedCount > 0) {
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
