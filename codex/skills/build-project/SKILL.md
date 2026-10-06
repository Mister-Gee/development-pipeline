---
name: build-project
description: "Take a new product/project from a raw idea to working code as a resumable, file-backed pipeline. Use when the user wants to \"start a new project\", \"build a new app\", \"I have an idea for…\", \"let's brainstorm a product\", \"spec out a new feature/product\", or otherwise wants the brainstorm → PRD → tech spec → plan → build → review loop. Brainstorms interactively with the user, writes PRD.md and TECH_SPEC.md, then hands off to task-planner → code-writer or junior-code-writer (per batch complexity) → code-reviewer (with fix rounds). Carries state in in-repo markdown files so a fresh session resumes from the files instead of re-explaining the idea. Explicitly trigger when the user invokes $build-project or asks to continue the build-project workflow."
---

# build-project

## Codex delegation reliability contract

Apply this contract before the phase-specific rules below. It supersedes any Claude-specific
tool syntax or fallback wording that remains in the source workflow.

### Role loading and task labels

Use this exact installed role map:

- task planner -> `{{CODEX_AGENTS_DIR}}/task-planner.toml`
- code reviewer -> `{{CODEX_AGENTS_DIR}}/code-reviewer.toml`
- senior writer -> `{{CODEX_AGENTS_DIR}}/code-writer.toml`
- junior writer -> `{{CODEX_AGENTS_DIR}}/junior-code-writer.toml`

`task_name is only a task label`; it does not load or bind an installed role. Every launch must
use a unique task label, and the label must not be treated as proof that the TOML was loaded.
Every self-contained dispatch message must begin
`ROLE: installed <role>. First read <absolute TOML path> and follow its developer_instructions.`
using the matching path above, then include `PHASE`, `PARENT_TASK: <canonical parent path>`,
repository/workspace, Task ID, input/artifact paths, scope, allowed writes, and verification.

### Preflight

Before every spawn, prove the execution path is healthy:

1. Read this skill and one small repository file.
2. Run one trivial read-only repository command such as `git status --short`.
3. Do not spawn if either operation hangs, times out, or reports an infrastructure failure.

Report `TOOL_FAILURE` and preserve the current phase when preflight fails. Spawning more workers
cannot repair an unhealthy execution provider.

### Dispatch

- Dispatch a selected worker phase; never tell a worker to invoke or reread an orchestration skill.
- Prefer `fork_turns: "none"` with a self-contained task packet. Otherwise inherit the smallest
  useful number of turns. Do not pass the full conversation or large raw error dumps.
- Permit only one writer in a checkout at a time.
- Every dispatch packet must include `PARENT_TASK: <canonical parent path>`. Require the worker
  to immediately call
  `collaboration.send_message(target=<PARENT_TASK>, message="READY: <phase> - <first action>")`
  before substantive work.
- Require the worker to call the same mailbox transport with
  `PROGRESS: <phase> - <completed checkpoint or long operation>` after meaningful checkpoints
  and immediately before any operation expected to outlast one watchdog window.
- Writing READY or PROGRESS only in the worker response stream does not satisfy the mailbox
  contract.

### Watchdog

1. Wait at most 60 seconds for meaningful progress or a tool result.
2. If none arrives, send one concise status request, call `list_agents`, and capture the first
   snapshot of the relevant artifacts and worktree state (for example, hashes, status, or diff
   statistics). Wait once more for at most 60 seconds, then call `list_agents` again and capture
   the second snapshot.
3. Mailbox timeout alone never authorizes interrupt_agent. Never call `interrupt_agent` merely
   to discover state. If the worker is `running` with current tool activity, a previously
   announced long operation, a status transition, or artifact/diff growth between the two
   snapshots, treat that evidence as progress, do not interrupt, and begin another bounded
   monitoring window.
4. Interrupt only when the worker remains `running`, does not answer the status request, has no
   current tool activity or previously announced long operation, and the two snapshots remain
   unchanged for the full stall window.
5. Retry at most once for a plausibly transient failure. The retry must call `spawn_agent` with
   `fork_turns: "none"` and a new unique task label such as
   `<role>_<scope>_retry_1_<timestamp>` so both the canonical task path and agent ID are new.
   `followup_task must never be used for a retry`.
6. Before retrying a writer, inspect the existing diff and artifacts. If any partial source or
   test diff exists, dispatch a fresh senior `code-writer` regardless of the original batch
   complexity. Tell it to recover from the current worktree without discarding correct partial
   work, and include the original plan scope plus the observed partial paths.

Do not repeatedly nudge, recursively spawn replacements, or wait indefinitely. After two
genuinely independent launches fail, stop the delegated phase with `TOOL_FAILURE` for execution
or provider failures, or `BLOCKED` for domain or task blockers. Retain `UNVERIFIABLE` for an
incomplete independent review. The orchestrator must not offer inline takeover of delegated
scope. Preserve partial diffs and artifacts for a future delegated continuation.

### Required worker completion envelope

```text
STATUS: COMPLETE | BLOCKED | TOOL_FAILURE
PHASE: scope | review | plan | implement | rereview
SCOPE: <task, batch, or finding IDs>
ARTIFACTS: <absolute paths or none>
CHANGES: <concise summary or none>
VERIFICATION: <commands and results or not run>
BLOCKER: <specific cause or none>
NEXT: <one recommended action>
```

`COMPLETE` is invalid when a required artifact is absent or required verification was not run.


The greenfield counterpart to `review-fix`. Same philosophy — **state lives in files, work
is delegated to the agent trio, the pipeline is resumable** — but it starts from an idea
instead of existing code. It exists so a product goes idea → PRD → spec → plan → code →
review without the user re-explaining the vision every session or losing the thread between
phases.

This skill is orchestration glue over the installed agent trio — `task-planner`,
`code-writer`, `code-reviewer` — plus `junior-code-writer` for MECHANICAL batches.
The skill itself owns the *front half* (brainstorm → PRD → spec); the *back half*
(plan → build → review → fix) is delegated to the agents — **mandatorily**, see the
Delegation Contract below.

## Delegation Contract (HARD RULE — read first)

The known failure mode of this skill is the main agent sliding from spec-writing straight
into planning and coding itself. The front/back split is a hard boundary:

- **Front half (you do directly)**: brainstorm with the user, write `PRD.md` and
  `TECH_SPEC.md`. That is ALL you author.
- **Back half (sub-agents only, via Codex collaboration subagent tools)**:
  - `plan` → `spawn_agent(task_name: "task_planner_plan_<project_or_milestone>_attempt_<n>_<timestamp_or_nonce>", message: points at PRD.md + TECH_SPEC.md, fork_turns: "none")`
  - `build` → route per batch Complexity (see **Batch Routing** below), then
    `spawn_agent(task_name: "code_reviewer_review_<milestone_or_batch>_attempt_<n>_<timestamp_or_nonce>", message: …, fork_turns: "none")`; fix rounds route to `code-writer` (senior)
- **You MUST NOT** author `PLAN.md`/`IMPL_NOTES.md`/`REVIEW.md` yourself, and MUST NOT
  use Edit/Write on any source or test file — not even scaffolding "to get things started."
- **Self-check at the plan gate**: the moment `TECH_SPEC.md` is confirmed, your next
  action is an `spawn_agent` call to `task-planner` — not writing steps yourself.
- No exception permits inline takeover of delegated scope. If the Codex collaboration subagent
  tools are unavailable or two genuinely independent launches fail, stop with `TOOL_FAILURE`
  for execution or provider failures, `BLOCKED` for domain or task blockers, or `UNVERIFIABLE`
  for an incomplete independent review. The orchestrator must not offer inline takeover; preserve
  partial diffs and artifacts for a future delegated continuation.

## Gate 0 — is the pipeline worth it? (new projects only; skip on resume)

A full pass is a brainstorm plus four sub-agent invocations per milestone — two of them on
the pipeline's most expensive tier — before any code exists. That is the right price for a
product and the wrong price for a script.

Before starting `brainstorm`, judge the ask. **If it is a single-file script or utility —
one user (the author), no persistence, no deployment target, no second session expected —**
put it to them rather than starting the pipeline:

> "This sounds like a single script rather than a project. `PRD.md` + `TECH_SPEC.md` +
> a planned build would be more ceremony than it's worth. I can just write it and run it,
> or run the full pipeline if you expect this to grow."

**The user's answer decides — never skip the pipeline silently.** If they choose direct,
the Delegation Contract is lifted for that script only. If they choose the pipeline, or
don't answer, proceed to `brainstorm` as normal.

Anything with users beyond the author, stored data, a deployment target, or an expectation
of being resumed later is a project — run the pipeline. This gate exists to skip ceremony
on throwaway work, never to skip planning on real work.

This gate is the **only** exception to the no-inline-takeover rule in the Codex delegation
contract above, and it applies only before any sub-agent has been dispatched. Once the
pipeline has started, the contract holds in full.

## Artifacts (single source of truth, written to the project repo)

Front half (this skill authors these):
- `PRD.md` — problem, target users, goals + non-goals, user stories, success metrics, constraints, open questions
- `TECH_SPEC.md` — stack rationale, architecture, data model, key interfaces, external deps, milestones, risks

Back half (the agents author these):
- `PLAN.md` — atomic steps with definition of done, each batch with a `Complexity` field (from `task-planner`)
- `IMPL_NOTES.md` — what was built, per step / fix round
- `REVIEW.md` — `code-reviewer`'s verdict (PASS / FAIL / CONDITIONAL_PASS) and findings
- `HANDOFF.md` — written by `junior-code-writer` if it runs out of context mid-batch;
  signals that remaining items in that batch must be routed to `code-writer` (senior)

Once these exist they are the memory. A new session resumes by re-invoking the skill — never
ask the user to re-describe the product if `PRD.md`/`TECH_SPEC.md` exist.

## Modes

Dispatch on the argument; with no argument, **infer the phase** from which artifacts exist
and continue: nothing → `brainstorm`; `PRD.md` only → `spec`; `+TECH_SPEC.md` → `plan`;
`+PLAN.md` → `build`; built but no passing `REVIEW.md` → `review`.

### `brainstorm`
Be a sharp thinking partner, not a stenographer. Interactively pull the idea into shape:
1. Understand the **problem and the user** before the solution.
2. Pressure-test scope: what's explicitly **in v1** vs deferred.
3. Use `the available user-input mechanism` for genuine forks — offer a recommended option first.
4. Converge. Summarize the direction and get a yes before writing the PRD.

Do **not** jump to a tech stack or code here — that's `spec`. Do not write files until the
user confirms the direction.

### `prd`
Write `PRD.md` from the brainstorm. Flag unresolved questions explicitly rather than
inventing answers. Confirm with the user.

### `spec`
Write `TECH_SPEC.md` from `PRD.md`. Recommend a stack with rationale, sketch the
architecture, data model, key interfaces, milestones, and top technical risks. Confirm before planning.

### `plan`
Delegate to `task-planner`, pointing it at `PRD.md` + `TECH_SPEC.md`. It produces `PLAN.md`
with atomic steps, test cases, verification commands, definition of done, and **a `Complexity`
field on each batch** (MECHANICAL / GUIDED / STRUCTURAL) — that field is what `build` uses
to route to the right code-writer. For a large product, plan **milestone by milestone**.

### `build`

**Batch Routing — apply this every time before dispatching an implement pass:**

```
1. Check if HANDOFF.md exists at the project root
   → YES: dispatch remaining items to code-writer (senior) [see Handoff Handling below]
   → NO: continue to step 2

2. Read the current milestone batch's Complexity field from PLAN.md:
   → MECHANICAL: dispatch to junior-code-writer
   → GUIDED or STRUCTURAL: dispatch to code-writer (senior)

3. Fix rounds (verdict is FAIL or CONDITIONAL_PASS in REVIEW.md):
   → ALWAYS dispatch to code-writer (senior), regardless of which agent ran the original batch
```

**Dispatching to junior-code-writer (MECHANICAL):**
- Tell junior: the plan file name (`PLAN.md`), the batch number to implement, and whether `AGENTS.md` / `CLAUDE.md` is present. Junior reads all files from disk via its own tools — do not paste file contents into the prompt.
- Do NOT mention REVIEW.md in the prompt unless you have confirmed there is no active FAIL/CONDITIONAL_PASS verdict — junior refuses fix mode and will stop if it sees one.

**Dispatching to code-writer (GUIDED / STRUCTURAL / fix rounds):**
- Tell code-writer: the plan file name (`PLAN.md`), the batch number (or "fix round" and the REVIEW.md verdict), and whether `TECH_SPEC.md` and `AGENTS.md` / `CLAUDE.md` are present. Code-writer reads all files from disk via its own tools — do not paste file contents into the prompt.

**After any code-writer or junior-code-writer returns:**
- Check for `HANDOFF.md` — if present, see Handoff Handling before continuing
- Then delegate to `code-reviewer` → `REVIEW.md`
- On FAIL / CONDITIONAL_PASS: send findings back to `code-writer` (senior) in fix mode, then re-review
- **Cap at 2 fix rounds** before escalating to the user (the trio's own guardrail)
- On PASS: advance to the next milestone's `plan` → `build` until the spec is delivered

**Handoff Handling (HANDOFF.md exists):**
- `junior-code-writer` ran out of context mid-batch and wrote `HANDOFF.md`
- Tell `code-writer` (senior): `HANDOFF.md` exists at the project root, the plan file name (`PLAN.md`), and the batch number. Code-writer reads `HANDOFF.md`, `TECH_SPEC.md`, and all other files from disk via its own tools — do not paste file contents into the prompt.
- `code-writer` will complete the remaining items and delete `HANDOFF.md` on success
- After senior completes: proceed to `code-reviewer` for the full batch as normal
- Tick ALL batch items (junior's completed + senior's) together once review passes

### `status`
Compact progress view: which phase the pipeline is in, milestones planned / built / passed,
any open questions still parked in `PRD.md`, and whether `HANDOFF.md` is present.

## Feedback & escalation (how you and the sub-agents reach me)

The front half (brainstorm → PRD → spec) is interactive by design — use `the available user-input mechanism`
for genuine forks and confirm at each gate. The back half runs through sub-agents launched
via Codex collaboration subagent tools, which **cannot talk to the user directly**. So questions from the agents
reach the user only if **you** relay them.

- **Check every sub-agent's return before continuing.** Scan its output and the artifact
  it wrote for: **Blocked Items** or open questions in `IMPL_NOTES.md`, a `HANDOFF.md`
  requiring senior handoff, an **escalation / two-fix-rounds-cap** stop, or BLOCKER
  findings the user should weigh in on. If any are present, **stop the pipeline** and
  put them to the user via `the available user-input mechanism` — do not advance to the next milestone.
- **Route genuine forks through `the available user-input mechanism`.** Any real decision is a structured
  question with a **recommended option first** and your reasoning, not a silent pick.
- **Sub-agents surface questions through files.** `code-writer` and `junior-code-writer`
  record blocked items in `IMPL_NOTES.md`; `junior-code-writer` records handoffs in
  `HANDOFF.md`. Reading those and relaying the open ones is your job, every round.
- **Don't invent answers to unblock.** If a sub-agent blocked an item for a real ambiguity,
  the fix is to ask the user — not to guess so the pipeline keeps moving.

## Rules

- **Files are the memory.** Never re-request the idea/context that already lives in `PRD.md`,
  `TECH_SPEC.md`, or `AGENTS.md` / `CLAUDE.md`. Resuming = re-invoking the skill in the project dir.
- **Confirm at each front-half gate** before proceeding.
- **Don't skip ahead.** No stack decisions during `brainstorm`; no code before `PLAN.md`.
- Keep sub-agent prompts scoped to one milestone.
- New empty project? Offer to scaffold the repo and a starter `AGENTS.md` / `CLAUDE.md` once `TECH_SPEC.md`
  is settled.

## Engineering guardrails (apply at every phase)

1. **Think before coding.** Surface assumptions and genuine forks out loud. If a simpler
   product or stack would do, say so and push back.
2. **Simplicity first.** v1 is the *minimum* product that tests the riskiest assumption.
   Prefer boring, few-moving-parts architecture.
3. **Surgical changes.** Every milestone's diff must trace to `PLAN.md` steps → `TECH_SPEC.md`
   → `PRD.md`. Pass this chain to the agents.
4. **Goal-driven execution.** Every PRD success metric, spec milestone, and plan step needs
   a binary check. "Build the app" is not a goal; "make these named tests pass" is.
