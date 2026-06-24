# The Verification Ladder

How this fork makes the autonomous Phase-4 loop trustworthy: a layered, adversarial verification chain that takes "this task is done" **out of the implementing agent's mouth** and grounds it in independent, cross-checked evidence.

> This document describes **current behavior in this fork** (not upstream). It is authoritative for the loop runner (`templates/spec-loop-run.sh`), the `[loop]` config, and the `harden-spec` prompt.

## The problem it solves

The background loop drives a spec's tasks to completion with a separate headless agent per task. The naive design lets that agent **implement its own task, write its own tests, run them, and declare itself green** — a textbook in-context reward-hacking surface (self-reported pass, weakened tests, trivially-satisfiable assertions). By Verifier's Law, how far you can trust an autonomous system is bounded by how *independent* its verification signal is. The ladder replaces self-certification with five independent gates.

## The ladder at a glance

Ordered by the failure they catch, from "the spec is wrong" down to "the parts don't assemble". Each is **opt-in** via `.spec-workflow/config.toml [loop]`.

| Layer | Failure it catches | Verdict source | Switch |
|---|---|---|---|
| **L3** Spec gate + SSC | The spec is misread/ambiguous, so code **and** tests verify the wrong thing | Cross-family auditor critiques the spec before any code | `specGate` · `harden-spec` |
| **L0** Execution ground truth | Agent lied about running / self-declared green | The loop **script** runs the task's scoped tests; exit code = verdict | `testCommand` |
| **L1** Harness integrity | Agent weakened/rewrote tests, special-cased visible cases | per-iteration tamper gate + whole-suite regression | (rides on L0) |
| **L2** Adequacy judge | Tests pass but are trivial / miss intent | **Opposite-engine** judge (codex↔claude) scores test adequacy | `judge` · `_Verify: panel` |
| **L4** Integration gate | Every part green, the assembled system won't build/boot | Real build+boot once at DONE; bounded auto-fix; optional cross-module judge | `integrationCommand` |

Two principles run through all of it:
- **Execution ground truth comes first.** An LLM judge is always a *second* gate behind a deterministic exit code — never the sole arbiter (LLM judges are not uniformly reliable). A soft layer that produces no readable verdict degrades to advisory, never to a hard block on good work.
- **The human owns the spec.** Nothing auto-rewrites `requirements.md`/`tasks.md`. L3 proposes; the human approves.

---

## L3 — Spec gate + SSC (Specification Self-Correction)

The one hole nothing downstream can catch: if the **acceptance criteria themselves** are vague, the agent writes code and `_Tests` that faithfully verify the wrong thing and *every* gate goes green (garbage-in).

- **`harden-spec` prompt** (human-invoked, during authoring): an adversarial self-critique — "if I implemented this to my own advantage, where could I satisfy the requirements/`_Tests` while missing intent?" It flags vague non-observable requirements, `_Tests` a trivial test would satisfy, missing adversarial/edge/security requirements, and requirements↔tasks gaps, then **proposes** hardening edits for you to approve. It does not edit files.
- **Pre-flight spec gate** (`specGate = true`): before implementing, an independent **cross-family** auditor (opposite of `[engine].default`) critiques the spec. On `fail` it writes `spec-gate-result.json` + `.spec-gate-failed`, logs `SPEC-GATE fail`, and the loop **aborts before touching any task**. No readable verdict / opposite engine unavailable → advisory pass (a soft pre-flight must not block all work on infra failure). Propose-only — the gate never edits the spec; run `harden-spec` or fix by hand, then re-run.

## L0 — Execution ground truth

The verdict moves from the agent to the harness. The implementing agent writes code **and** the task's tests but does **not** call `verify-task` or touch task markers. After it returns, the loop **script** runs the task's scoped tests and records green/red from the **exit code** (`verifiedBy: "harness-exec"` in `verify-results/`).

- **Per-task scope, not the whole suite.** Each task declares a `_Tests:` selector (a test file/glob) in `tasks.md`. The gate runs *only* that scope, so a multi-task spec doesn't deadlock on later tasks' not-yet-written tests. `testCommand` is a template, e.g. `"npm test -- {tests}"`, where `{tests}` is the current task's scope.
- The agent is the **sole author** of test *content* (the residual hole L2 closes); the harness owns whether they *ran and passed*.
- Without `testCommand`, the loop falls back to the deprecated agent-self-report path and says so loudly.

## L1 — Harness integrity

L0 proves the agent's tests ran; L1 stops the agent from rigging them. All checks run inside the loop, around the implement step:

- **Tamper gate.** The agent must not edit `tasks.md` (its acceptance contract — including the `_Tests`/`_Verify` selectors) or modify a **pre-existing** scoped test file. The loop snapshots state *after* it picks the task (so `pick`'s own `[-]` write isn't flagged), and compares: any `tasks.md` change → blocked; a pre-existing tracked test in the task's scope modified → blocked. Newly-*added* test files are fine.
- **Regression signal.** After a task goes green, the union of all completed scopes runs once; if a previously-green scope now fails, the regression is flagged (without un-greening the current task).
- **Non-git honesty.** Outside a git repo the pre-existing-test check can't run; the loop logs `TAMPER-GATE OFF` and stamps every verdict `tamperGate: "off"` so the degradation is durably auditable.

## L2 — Cross-family adequacy judge

Closes L0's residual: agent-authored tests can be trivial (`assert(true)`). After a harness-green, an independent judge running on the **opposite engine family** (codex judges claude's work and vice versa — killing same-model self-preference bias) reads the requirements, the scoped tests, and the implementation, and asks only: **are these tests adequate?** (do they call the real code and assert meaningful behavior, cover the `_Requirements`, and address task-type adversarial holes).

- The judge can only **downgrade** a green (reopen the task to strengthen its tests, bounded by `judgeMaxAttempts`, then block `[~]`) — it can never override a red.
- Security-critical tasks tagged `_Verify: panel` get a multi-lens consensus: the cross-family judge **plus** the `security-reviewer` and `logic-reviewer` agents; any fail → fail.
- Enabled by `judge = true`. Judge produced no output (timeout/infra) → recorded `skipped`, green kept. Judge produced output but no parseable verdict → treated as **fail** (an unreadable objection must not become a pass).

## L4 — Integration terminal gate

Per-task green ≠ the assembled system works. Once the spec reaches **DONE** (and only then), the loop runs `integrationCommand` — the real build + boot smoke, including the whole-tree `tsc`/build that per-task verification deliberately skips.

- On failure: a **bounded auto-fix** (one claude pass keyed on the failure output, forbidden from weakening tests), then re-run; still failing after `integrationFixAttempts` → report and stop.
- On a green build, if `integrationJudge = true`, a cross-module judge reads the boot output + every task's Implementation Log for contract holes a green build can't catch (API↔frontend field mismatches, middleware order, bootstrap/secret requirements). An explicit judge `fail` gates and triggers a bounded fix; an unreadable judge does **not** override the passing build (ground-truth-first).
- Result is recorded durably in `integration-result.json` (+ `.integration-failed` marker on fail), with `incompleteBlocked` flagging any `[~]` tasks.

---

## Config reference (`.spec-workflow/config.toml`)

```toml
[engine]
default = "claude"            # implementer; the judge/auditor use the OPPOSITE family
maxFixAttempts = 5            # L0 red-fix attempts before a task is blocked [~]

[loop]
autoLoop = true              # master switch for the background runner
maxIterations = 50
noProgressStop = 3

# L0 + L1
testCommand = "npm test -- {tests}"   # {tests} = the current task's _Tests scope. Unset → self-cert (deprecated)
coverageMin = 0              # optional L1 coverage floor (0-100), enforced only if set

# L2
judge = false                # opt-in cross-family adequacy judge
judgeMaxAttempts = 2         # judge-fail reopen rounds before [~]

# L4
integrationCommand = "npm run build && npm run smoke"   # opt-in; the assembled build+boot
integrationFixAttempts = 1   # bounded auto-fix rounds
integrationJudge = false     # opt-in cross-module review after a green build+boot

# L3
specGate = false             # opt-in cross-family spec auditor; aborts the loop on a hackable spec
```

**Task metadata** (in `tasks.md`, set at spec time, locked by L1):
- `_Tests:` — the task's acceptance selector (L0 runs exactly this).
- `_Verify: panel` — opt this task into the L2 reviewer panel.
- `_Engine:` — `claude` (default) or `codex`; the judge family is the opposite of this.
- `_Requirements:` / `_Leverage:` / `_Prompt:` — as in upstream.

### Enabling progressively

Each layer is independent. A reasonable adoption order: `testCommand` (L0/L1, the foundation) → `judge` (L2) → `specGate` (L3) → `integrationCommand` (L4). Cost rises with each LLM gate (L2/L3/L4 add an opposite-engine agent), so they default off.

## How it's verified

Each loop layer has a deterministic harness that installs fake `claude`/`codex` shims (the shim is the adversary, since real models can't be reliably made to misbehave) and runs the **real** `spec-loop-run.sh`, asserting on the audit log + task state. The shims validate the **gate logic**; real engines were validated separately on the happy path and on real adversarial inputs.

| Suite | Command | Covers |
|---|---|---|
| Unit | `npx vitest run` | `verify-core` (verdicts/provenance/judge), `_Tests`/`_Verify` parsing, `pick`/`scopes`/`verify`/`judge-record` CLIs, `harden-spec` |
| L1 | `npm run test:loop` | tamper (test/`_Tests`/`_Verify` edits), regression, blocker, pick-write-not-flagged, non-git flag |
| L2 | `npm run test:loop:l2` | cross-family routing, pass/fail→reopen→cap, panel any-fail, no-output→skip vs unparseable→fail, disabled |
| L3 | `npm run test:loop:l3` | gate pass→proceed, fail→abort-before-implement, no-output→advisory, disabled |
| L4 | `npm run test:loop:l4` | pass, fail→bounded-fix→pass, fail→exhausted, cross-module judge fail, not-DONE→skip, disabled |

**Real-engine live checks performed:** L2 — real codex returned `VERDICT: fail` on a trivial `assert(true)` test and `VERDICT: pass` on a well-written one (both directions, no false-negative). L3 — real codex flagged a vague spec (`"login should be secure"`) `VERDICT: fail`: *"the spec permits a nonfunctional or insecure login implementation to pass trivial tests."*

## Honest limits

- **L3 is the softest layer:** an LLM auditing natural-language intent — there is no exit code for "the spec means what the human wanted." It is propose-only and complements, not replaces, human spec review.
- **L2's residual:** the cross-family judge reduces, but cannot eliminate, shared-model blind spots; it is a second gate, not ground truth.
- **L4's depth is whatever `integrationCommand` runs.** The harness guarantees it *ran* and gates on its exit code; it does not invent integration tests you didn't write.
- **A bounded auto-fix can, in principle, game a build.** It is forbidden from weakening tests, capped by `*FixAttempts`, and surfaced in the durable result for human review.

The ladder raises the cost of every reward-hacking move and makes each one auditable — it does not claim to make autonomous output infallible.
