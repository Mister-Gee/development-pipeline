---
name: review-fix
description: "Run a full codebase review and drive the fixes to completion as a resumable, file-backed pipeline. Use when the user asks to \"review this codebase\", \"do a full code review\", \"plan the fixes\", \"implement the fix plan\", \"copy the plan to an md file\", or otherwise wants the review → fix-plan → per-fix implementation → re-review loop. Carries state in in-repo markdown files (REVIEW.md, FIX_PLAN.md, IMPL_NOTES.md) so a fresh session resumes from the files instead of a re-pasted mega-prompt. Explicitly trigger when the user invokes $review-fix or asks to continue the review-fix workflow."
---

# review-fix

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
using the matching path above, then include `PHASE`, `PARENT_TASK: <canonical parent path>`, `TASK_DIR: <task folder>`,
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


A resumable pipeline for the recurring "review a codebase, plan the fixes, implement
them one prompt at a time, review again" workflow. It exists to kill three specific
failure modes seen repeatedly in past sessions:

1. **Re-pasted mega-prompts** — a fresh session per fix, each re-attaching architecture
   docs. Fix: **state lives in files** (`REVIEW.md`, `FIX_PLAN.md`, `IMPL_NOTES.md`),
   and project context comes from `AGENTS.md` / `CLAUDE.md`. Never ask the user to re-paste context
   that already exists in the repo.
2. **"Prompt is too long"** — one giant plan/implement prompt blowing the length limit.
   Fix: fixes are **batched**; each implement pass takes one small batch.
3. **Lost work / duplicate sessions** — re-running a plan from scratch. Fix: the plan is
   a **checklist**; completed items are ticked and skipped on resume.

This skill is orchestration glue over the installed agent trio — `task-planner`,
`code-writer`, `code-reviewer` — plus `junior-code-writer` for MECHANICAL batches.
Delegating to them is **mandatory, not preferred** — see the Delegation Contract below.

## Delegation Contract (HARD RULE — read first)

You are the **orchestrator only**. The known failure mode of this skill is the main
agent doing the review, planning, or coding itself "because it's faster". Do not.

- **You MUST NOT**: run the code audit yourself, author `REVIEW.md`/`FIX_PLAN.md`/
  `IMPL_NOTES.md` content yourself, or use Edit/Write on any source or test file.
  Your only direct writes are ticking checkboxes in `FIX_PLAN.md` and small
  bookkeeping edits to the artifacts the sub-agents produced.
- **You MUST** launch the sub-agents via Codex collaboration subagent tools:
  - `review`/`rereview` → `spawn_agent(task_name: "code_reviewer_<review_or_rereview>_<task_id>_attempt_<n>_<timestamp_or_nonce>", message: …, fork_turns: "none")`
  - `plan` → `spawn_agent(task_name: "task_planner_plan_<task_id>_attempt_<n>_<timestamp_or_nonce>", message: …, fork_turns: "none")`
  - `next` → route per batch Complexity (see **Batch Routing** below)
- **Self-check before every phase**: if you are about to Read more than a handful of
  source files, or about to write findings/plan/code text yourself, stop — that work
  belongs to a sub-agent. Compose its prompt and launch it instead.
- No exception permits inline takeover of delegated scope. If the Codex collaboration subagent
  tools are unavailable or two genuinely independent launches fail, stop with `TOOL_FAILURE`
  for execution or provider failures, `BLOCKED` for domain or task blockers, or `UNVERIFIABLE`
  for an incomplete independent review. The orchestrator must not offer inline takeover; preserve
  partial diffs and artifacts for a future delegated continuation.

## Gate 0 — is the pipeline worth it? (new runs only; skip on resume)

A full pass is four sub-agent invocations (review → plan → fix → re-review), two of them on
the pipeline's most expensive tier. That is the right price for a codebase audit and the
wrong price for one known bug.

Before dispatching `review`, judge the request. **If the user is pointing at a specific
known defect rather than asking for a codebase-wide audit, and the fix plausibly touches
≤2 files**, put it to them rather than dispatching:

> "You've named a specific bug rather than asked for an audit. The full review → plan →
> fix → re-review pipeline is probably overkill. I can fix it directly and run the
> project's verification, or run the pipeline anyway if you want the findings and review
> artifacts."

**The user's answer decides — never skip the pipeline silently.** If they choose direct,
the Delegation Contract is lifted for that fix only. If they choose the pipeline, or
don't answer, proceed to `review` as normal.

An explicit request to "review the codebase" is never a candidate for this gate — that
*is* the pipeline's job. Run the pipeline when in doubt, and always when the defect
touches auth, permissions, persistence, migrations, money, or data integrity. This gate
exists to skip ceremony on small work — never to skip review on risky work.

This gate is the **only** exception to the no-inline-takeover rule in the Codex delegation
contract above, and it applies only before any sub-agent has been dispatched. Once the
pipeline has started, the contract holds in full.

## Where the files live (`.pipeline/`)

New tasks keep every pipeline file under `.pipeline/` at the repo root, never loose in the
root itself.

```
.pipeline/
  product/                                # build-project only
    PRD.md  TECH_SPEC.md
  20261007-review-fix-auth-audit/         # one folder per task
    REVIEW.md  FIX_PLAN.md  IMPL_NOTES.md  HANDOFF.md
  20261009-review-implement-csv-export/
    FEATURE_SPEC.md  IMPL_PLAN.md  IMPL_NOTES.md  REVIEW.md
  20261012-build-project-m1-accounts/     # build-project: one folder per milestone
    PLAN.md  IMPL_NOTES.md  REVIEW.md
```

- **Task folder name:** `<YYYYMMDD>-<skill>-<short-kebab-slug>`. Take the date from the
  shell (`date +%Y%m%d`), not from memory. The folder name is the Task ID every agent copies
  into its files.
- **Older tasks at the repo root (1.x layout) still work.** If the repo root has `PLAN.md`,
  `FIX_PLAN.md`, `IMPL_PLAN.md`, `FEATURE_SPEC.md`, `REVIEW.md`, `IMPL_NOTES.md` or
  `HANDOFF.md`, that is a task too: call it **root**. Offer once to move it into a
  `.pipeline/` task folder (named from its Task ID, or `<YYYYMMDD>-<skill>-legacy`), using
  `git mv` for tracked files. **Never move anything without a yes**: a root `PLAN.md` may be
  the project's own document. If the user declines, keep working with it in place using
  `TASK_DIR: .`. For build-project, look for `PRD.md` / `TECH_SPEC.md` in
  `.pipeline/product/` first, then at the repo root.
- **Git-ignore `.pipeline/`.** The first time you create `.pipeline/` in a git repo, add a
  `.pipeline/` line to `.gitignore` (create the file if needed). Pipeline files are local
  working state, and a `REVIEW.md` can describe security problems that are not fixed yet,
  which must never reach a public repo. This is the one edit outside the task folder you may
  make. If the user later removes the line, don't add it back.
- **List task folders with the shell** (`ls -d .pipeline/*/`). Search tools such as Glob and
  Grep may skip git-ignored folders.

### Choosing the task

1. **Split the argument.** A word matching one of this skill's mode names is the mode.
   Anything else is a **task reference**.
2. **A task reference was given:** match it against this skill's task folders (and **root**),
   ignoring case, the date and the skill name. Try, in order: the exact slug; slugs
   containing every word of the reference; the closest slug. `root` or `legacy` means the
   root task.
   - one match → resume it, even if it is finished or was abandoned
   - several → ask the user which one, newest first
   - none → the reference is a new request: start a new task with a slug made from it
3. **No task reference:** resume this skill's one **unfinished** task. A task is finished
   when its plan file is fully ticked and its `REVIEW.md` verdict is PASS. If several are
   unfinished, ask which one, newest first, and remind the user they can pass a name next
   time. If none are, start a new task.
4. **Starting a new task:** create its folder before the first dispatch.

Never delete or rewrite another task's folder. Old folders are history; because every task
has its own folder, nothing needs clearing before a new one starts.

### Enforcement (every dispatch)

- **Every dispatch starts with `TASK_DIR: <task folder>`** (`TASK_DIR: .` for the root
  task). An agent dispatched without it stops with BLOCKED and does nothing. That is a
  wasted dispatch, so never omit it.
- **After every sub-agent returns, check its work before anything else:**
  1. The file it was meant to produce exists in `TASK_DIR`: `FEATURE_SPEC.md` or `REVIEW.md`
     after scope/review, the plan file after plan, `IMPL_NOTES.md` after implement.
  2. No pipeline file appeared or changed outside `TASK_DIR`. Check the paths the agent
     lists in its final message, run `git status --porcelain --untracked-files=all`, and
     list the repo root. Any of the file names above at the root (when `TASK_DIR` is not
     `.`) or in another task's folder is a stray.
  3. Move a stray into `TASK_DIR` (that counts as bookkeeping) and tell the user. If the
     expected file is missing, the dispatch failed: re-dispatch once with the same
     `TASK_DIR`, then stop and report.

## Artifacts (single source of truth, written to the task folder)

- `REVIEW.md` — findings from the review, each with an ID (`F-001`…), severity
  (BLOCKER / MAJOR / MINOR), affected files, and a one-line description.
- `FIX_PLAN.md` — an ordered **checklist**. Each item: `- [ ] F-00N (SEV) — summary`
  followed by a 1–3 line implementation note and the files it touches. Items grouped
  into **batches** (`## Batch 1`, `## Batch 2`, …) each with a `Complexity` field
  (MECHANICAL / GUIDED / STRUCTURAL) set by `task-planner`.
- `IMPL_NOTES.md` — appended per implement pass: what changed, per finding.
- `HANDOFF.md` — written by `junior-code-writer` if it runs out of context mid-batch;
  signals that remaining items in that batch must be routed to `code-writer` (senior).

Each run gets its own task folder (see **Where the files live**), so nothing needs
clearing before a new task starts.

## Modes

Dispatch on the argument; with no argument, **infer the phase** from which artifacts exist in the task folder being resumed
and continue (no artifacts → `review`; `REVIEW.md` only → `plan`; `FIX_PLAN.md` with
unchecked items → `next`; all items checked → `rereview`).

### `review`
1. Read `AGENTS.md` / `CLAUDE.md` (and any repo review/contract docs) for context.
2. Delegate the audit to `code-reviewer`. Read-only: no edits in this phase.
3. Write findings to `REVIEW.md` with stable IDs and severities. Summarize the top items
   to the user; stop for direction unless they said to proceed straight through.

### `plan`
1. Delegate to `task-planner` via Codex collaboration subagent tools, pointing it at `REVIEW.md`. Instruct it
   to produce `FIX_PLAN.md`: ordered checklist, grouped into batches of ~3–5 related
   findings, each batch with a `Complexity` field (MECHANICAL / GUIDED / STRUCTURAL).
2. Require that each item get a short, concrete implementation note, the exact files to
   touch, and — for MECHANICAL batches — inline code pattern quotes (no file discovery).
3. Relay any per-item user overrides into the planner's prompt. Do not implement yet.

### `next`

**Batch Routing — apply this every time before dispatching:**

```
1. Check if HANDOFF.md exists in the task folder
   → YES: dispatch remaining items to code-writer (senior) [see Handoff Handling below]
   → NO: continue to step 2

2. Read the first unchecked batch's Complexity field from FIX_PLAN.md:
   → MECHANICAL: dispatch to junior-code-writer
   → GUIDED or STRUCTURAL: dispatch to code-writer (senior)

3. Fix rounds (verdict is FAIL or CONDITIONAL_PASS in REVIEW.md):
   → ALWAYS dispatch to code-writer (senior), regardless of which agent ran the original batch
```

**Dispatching to junior-code-writer (MECHANICAL):**
- Tell junior: `TASK_DIR`, the plan file name (`FIX_PLAN.md`), the batch number to implement, and whether `AGENTS.md` / `CLAUDE.md` is present. Junior reads all files from disk via its own tools — do not paste file contents into the prompt.
- Do NOT mention REVIEW.md in the prompt unless you have confirmed there is no active FAIL/CONDITIONAL_PASS verdict — junior refuses fix mode and will stop if it sees one.

**Dispatching to code-writer (GUIDED / STRUCTURAL / fix rounds):**
- Tell code-writer: `TASK_DIR`, the plan file name (`FIX_PLAN.md`), the batch number (or "fix round" and the REVIEW.md verdict), and whether `FEATURE_SPEC.md` or `AGENTS.md` / `CLAUDE.md` are present. Code-writer reads all files from disk via its own tools — do not paste file contents into the prompt.

**After any sub-agent returns:**
- Check for `HANDOFF.md` — if present, see Handoff Handling below before ticking items
- If no HANDOFF.md and batch succeeded: tick those items in `FIX_PLAN.md`, append what changed to `IMPL_NOTES.md`
- Surface any blocked items to the user via `the available user-input mechanism` before continuing
- Report the batch result and stop so the user can test between batches

**Handoff Handling (HANDOFF.md exists):**
- `junior-code-writer` ran out of context mid-batch and wrote `HANDOFF.md`
- Tell `code-writer` (senior): `HANDOFF.md` exists in `TASK_DIR`, the plan file name (`FIX_PLAN.md`), and the batch number. Code-writer reads `HANDOFF.md` and all other files from disk via its own tools.
- `code-writer` will complete the remaining items and delete `HANDOFF.md` on success
- On senior completion: tick ALL items in the batch (both junior's completed items and senior's completion)
- Do not re-run the completed items listed in `HANDOFF.md`

### `rereview`
1. Delegate to `code-reviewer` to verify each fixed finding actually resolved; update
   `REVIEW.md` verdicts.
2. Any regressions or incomplete fixes become **new unchecked items** appended to
   `FIX_PLAN.md` — then it's `next` again. Cap fix-rounds at 2 before escalating to the
   user (matches the trio's guardrail).

### `status`
Print a compact progress view: total findings by severity, batches done / remaining,
which artifact phase the pipeline is in, and whether HANDOFF.md is present.

## Feedback & escalation (how you and the sub-agents reach me)

Sub-agents launched via Codex collaboration subagent tools **cannot talk to the user directly** — each runs to
completion and returns one final message to you, the orchestrator. So questions reach the
user only if **you** relay them.

- **Check every sub-agent's return before continuing.** Scan its output and the artifact
  it wrote for: **Blocked Items** or open questions in `IMPL_NOTES.md`, a `HANDOFF.md`
  requiring senior handoff, an **escalation / two-fix-rounds-cap** stop, or BLOCKER
  findings the user should weigh in on. If any are present, **stop the pipeline** and
  put them to the user via `the available user-input mechanism`.
- **Route genuine forks through `the available user-input mechanism`.** Any real decision is a structured
  question with a **recommended option first** and your reasoning, not a silent pick.
- **Sub-agents surface questions through files.** `code-writer` records blocked items in
  `IMPL_NOTES.md`; `junior-code-writer` records blocked items in `IMPL_NOTES.md` and
  context handoffs in `HANDOFF.md`. Reading those and relaying open ones is your job.
- **Don't invent answers to unblock.** If a sub-agent blocked an item for a real ambiguity,
  the fix is to ask the user — not to guess so the pipeline keeps moving.

## Rules

- **Never re-request context that lives in `AGENTS.md` / `CLAUDE.md` or repo docs.** Read it.
- **Audit before editing** — `review` and `plan` make no code changes.
- Keep prompts to sub-agents scoped to one batch.
- State is the files. If interrupted, resuming is just re-invoking the skill in the repo.

## Engineering guardrails (apply at every phase)

1. **Think before coding.** In `plan`, state assumptions explicitly. If a finding has
   multiple plausible fixes, present the options with a recommendation — don't pick silently.
2. **Simplicity first.** The fix is the *minimum* change that resolves the finding.
3. **Surgical changes.** Every changed line in a batch must trace to a specific finding ID.
   Pass this rule to `code-writer` verbatim. Newly-orphaned imports/vars from a fix get
   removed; pre-existing dead code gets *mentioned* in `REVIEW.md`, never deleted.
4. **Goal-driven execution.** Each `FIX_PLAN.md` item must carry a binary verification.
   A batch isn't ticked until its items' checks were actually run and passed.
