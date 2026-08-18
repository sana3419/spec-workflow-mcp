# Spike: could Claude Code Dynamic Workflows replace the bash loop runner?

Status (2026-08-18): **no — keep `spec-loop-run.sh` as the canonical Phase-4 runner.** Workflows are
used where they fit: parallel review fan-out with adversarial verification (`templates/workflows/review-fanout.workflow.js`).

## What was tried / reasoned

| Ladder guarantee | In the bash runner | In a Workflow script | Verdict |
|---|---|---|---|
| **L0** the *harness* runs the tests and reads the exit code | `bash -c "$TEST_CMD"` in the script | A workflow script has **no shell** — only `agent()`. The verdict would have to come from an agent that runs the tests, i.e. an LLM is back in the loop between "tests ran" and "verdict recorded". | ✗ breaks the core promise |
| **L1** tamper gate snapshot before/after the implementing agent, regression union on the merged tree | `cksum`/`git status` around the agent step in one working tree | Parallel `agent()` calls in worktrees have no shared snapshot; regression must run after merge — again only via an agent | ✗ needs a shell + serialisation |
| **L2/L3/L4** judge on the *opposite* model family | `codex exec` | `agent()` spawns Claude only; `codex` needs Bash | ✗ same-family bias returns |
| Determinism / resumability | bash + on-disk state | Workflow runtime resumes cached `agent()` calls — good, but the *state* it caches is agent output, not harness verdicts | ~ |
| Parallel independent tasks | not supported (strictly serial) | natural (`pipeline`, `isolation: 'worktree'`) | ✓ the one real win |

The one attractive property (parallel implement steps in worktrees) is *also* the one that dismantles L1.
To parallelise safely the runner would need: per-worktree baseline snapshots, a serialised integration
branch where L0/L1 verdicts are recorded only after merge, and a `_DependsOn` tag in tasks.md. That is a
runner feature (bash or a Node port of the runner), not a Workflow feature.

## What we use Workflows for

* `templates/workflows/review-fanout.workflow.js` — for `/review --full` on big diffs: routes with
  `review-route`, runs every selected reviewer as its own subagent in parallel, then three independent
  skeptics try to refute each BLOCK before it is reported (kills plausible-but-wrong findings). Findings
  are advisory input to a human; nothing here writes task state.
* Possible next: L3 spec hardening as a judge panel (N independent hardeners → merged proposals),
  still propose-only.

## Decision

* Runner stays bash + `verify-core`; the Telegram gates and `.run/` state added in v3 are runner
  features and work with it.
* Parallel tasks, if ever, go into the runner behind `_DependsOn` with post-merge verification.
