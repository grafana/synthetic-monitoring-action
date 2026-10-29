# synthetic-monitoring-action

> Warning: This is a POC. Don't use it.

A GitHub Action that adds Grafana Synthetic Monitoring awareness to your pull requests.

```yaml
- uses: grafana/synthetic-monitoring-action@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    grafana-stack-url: https://myorg.grafana.net
    sm-token: ${{ secrets.SM_TOKEN }}
    check-impact: "true"    # Flag checks the PR's diff may break
    suggest-checks: "true"  # Propose checks for new, uncovered flows
    sync-enabled: "true"    # Apply a checks-as-code source to live state
    checks-dir: sm-checks/
```

Results are posted as a single sticky comment on the PR, updated in place on every run. For example:

> ## SM Check Impact Report
>
> - login-journey-browser: AFFECTED - the diff renames `#login-submit` to `#sign-in`, which this check clicks
> - checkout-api-flow: AFFECTED - `POST /api/orders` now returns `201` instead of `200`
> - api-health: OK
> - edge-ping: OK
>
> 2 of 4 checks potentially affected.

## Requirements

- A Grafana Cloud stack
- A Grafana service-account token (read-only, or write access when `sync-enabled` is on)
- An Anthropic API key

## Usage

Reference workflows live in [`examples/workflows/`](examples/workflows/):

- [`pr-check.yml`](examples/workflows/pr-check.yml) - impact check and suggestions on every PR
- [`sync-apply.yml`](examples/workflows/sync-apply.yml) - sync, only on push to `main`
- [`everything-enabled.yml`](examples/workflows/everything-enabled.yml) - every input at once, with the caveats that implies
- [`smoke.yml`](examples/workflows/smoke.yml) - `mode: smoke`: run one check once against a fresh deploy and fail unless every probe succeeds

`mode: smoke` runs `gcx synthetic-monitoring checks test` (needs gcx v1.6.0+). On `pull_request` events it also posts the probe table as a sticky comment; set `smoke-comment: "false"` to skip that and post your own, embedding the report file at the `smoke-report` output.

## Running locally

```
export ANTHROPIC_API_KEY=sk-ant-...

SM_ACTION_LIVE_CHECKS_FILE=fixtures/checks.yaml \
SM_ACTION_DIFF_FILE=fixtures/pr.diff \
SM_ACTION_SUGGEST_CHECKS=true \
npx tsx src/run.ts
```

This runs impact check and suggestions against fixtures, with no `gcx` or git calls.

## Repo layout

```
action.yml             # the composite action
src/
  run.ts               # impact-check + suggest-checks (the agent)
  tools.ts             # agent tools: get_sm_checks / get_pr_diff
  suggest.ts           # discover -> judge pipeline for suggestions
  checks-data.ts       # loading, YAML parsing, scoping
  sync.ts, sync-plan.ts  # sync entrypoint + pure diff logic
  smoke-run.ts, smoke.ts # smoke-test entrypoint + pure check rewrite / probe gating
  post-comment.ts, gh.ts, report.ts  # CI glue (sticky comments, verdict parsing)
examples/workflows/    # reference workflows for a consuming repo
fixtures/              # local test data
```

## Caveats

- Proof of concept. Not yet run from inside a real GitHub repo/PR: comment posting was verified with a `gh` mock, and via `act` reaching the real `gh` binary.
- **Don't run `src/sync.ts` locally with real credentials.** `SM_ACTION_LIVE_CHECKS_FILE` only overrides the *read* side; create/update/delete always shell out to the real `gcx`, and will write to whatever stack it's logged into. Point `GRAFANA_SERVER`/`GRAFANA_TOKEN` (or `XDG_CONFIG_HOME`/`HOME`) at an empty config, or put a mock `gcx` first on `PATH`.
- `check-impact` and `suggest-checks` need a PR diff, so they only work on `pull_request` events.
- `sync-enabled` on a `pull_request` trigger applies on every push to the PR branch, not just on merge.
- Ping, DNS and TCP checks are never flagged by `check-impact`.
- Each `mode: smoke` run is billed like a scheduled execution on every probe in the check.
- `smoke-wait-timeout` matches `smoke-body-regexp` in JavaScript; the probes match it in Go's RE2. Keep the pattern simple (no lookarounds or backreferences).
