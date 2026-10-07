---
name: review-implement
description: "Scope a new feature against the codebase and drive it to a working implementation as a resumable, file-backed pipeline. Use when the user asks to \"add a feature\", \"build this feature\", \"scope this out\", \"plan the feature\", \"implement the feature plan\", \"spec a new capability\", or otherwise wants the scope → feature-plan → per-batch implementation → review loop for NEW functionality (not bug fixes — use review-fix for those). Carries state in in-repo markdown files (FEATURE_SPEC.md, IMPL_PLAN.md, IMPL_NOTES.md, REVIEW.md) so a fresh session resumes from the files instead of a re-pasted mega-prompt. Explicitly trigger when the user invokes $review-implement or asks to continue the review-implement workflow."
---

# review-implement

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

A resumable pipeline for the recurring "scope a new feature, plan it, build it one
batch at a time, review it" workflow. It is the sibling of `review-fix`: same machinery,
but the input is a **feature request** and the output is **new functionality**, not a set
of fixes. It exists to kill three specific failure modes:

1. **Re-pasted mega-prompts** — a fresh session per batch, each re-attaching architecture
   docs and the feature description. Fix: **state lives in files** (`FEATURE_SPEC.md`,
   `IMPL_PLAN.md`, `IMPL_NOTES.md`), and project context comes from `AGENTS.md` / `CLAUDE.md`.
2. **"Prompt is too long"** — one giant plan/implement prompt blowing the length limit.
   Fix: implementation is **batched**; each implement pass takes one small batch.
3. **Lost work / duplicate sessions** — re-running a plan from scratch. Fix: the plan is
   a **checklist**; completed items are ticked and skipped on resume.

This skill is orchestration glue over the installed agent trio — `code-reviewer`,
`task-planner`, `code-writer` — plus `junior-code-writer` for MECHANICAL batches.
Delegating to them is **mandatory, not preferred** — see the Delegation Contract below.

## Delegation Contract (HARD RULE — read first)

You are the **orchestrator only**. The known failure mode of this skill is the main
agent doing the scoping, planning, or coding itself "because it's faster". Do not.

- **You MUST NOT**: scope the codebase yourself, author `FEATURE_SPEC.md`/`IMPL_PLAN.md`/
  `IMPL_NOTES.md`/`REVIEW.md` content yourself, or use edit/write tools on any source or test
  file. Your only direct writes are ticking checkboxes in `IMPL_PLAN.md` and small
  bookkeeping edits to the artifacts the sub-agents produced.
- **You MUST** launch the sub-agents via Codex collaboration subagent tools:
  - `scope` → `spawn_agent(task_name: "code_reviewer_scope_<task_id>_attempt_<n>_<timestamp_or_nonce>", message: …, fork_turns: "none")`
  - `plan` → `spawn_agent(task_name: "task_planner_plan_<task_id>_attempt_<n>_<timestamp_or_nonce>", message: …, fork_turns: "none")`
  - `next` → route per batch Complexity (see **Batch Routing** below)
  - `review`/`rereview` → `spawn_agent(task_name: "code_reviewer_<review_or_rereview>_<task_id>_attempt_<n>_<timestamp_or_nonce>", message: …, fork_turns: "none")`
- **Self-check before every phase**: if you are about to Read more than a handful of
  source files, or about to write spec/plan/code text yourself, stop — that work belongs
  to a sub-agent. Compose its dispatch message and launch it instead.
- No exception permits inline takeover of delegated scope. If the Codex collaboration subagent
  tools are unavailable or two genuinely independent launches fail, stop with `TOOL_FAILURE`
  for execution or provider failures, `BLOCKED` for domain or task blockers, or `UNVERIFIABLE`
  for an incomplete independent review. Preserve partial diffs and artifacts for a future
  delegated continuation.

## Gate 0 — is the pipeline worth it? (new features only; skip on resume)

A full pass is four sub-agent invocations (scope → plan → implement → review). That is the
right price for real feature work and the wrong price for a small one.

Before dispatching `scope`, judge the request. **If it plausibly touches ≤2 files,
introduces no new interface, type, or module, and plugs into an integration point the user
already named**, put it to them rather than dispatching:

> "This looks like a ~N-file change. The full scope → plan → build → review pipeline is
> probably overkill here. I can make the change directly and run the project's
> verification, or run the pipeline anyway if you want the spec and review artifacts."

**The user's answer decides — never skip the pipeline silently.** If they choose direct,
the Delegation Contract is lifted for that change only. If they choose the pipeline, or
don't answer, proceed to `scope` as normal.

Run the pipeline when in doubt, and always when the change touches auth, permissions,
persistence, migrations, money, or anything user-facing and irreversible. This gate exists
to skip ceremony on small work — never to skip review on risky work.

This gate is the **only** exception to the no-inline-takeover rule in the Codex delegation
contract above, and it applies only before any sub-agent has been dispatched. Once the
pipeline has started, the contract holds in full.

## Where the files live (`.pipeline/`)

Every file this pipeline writes lives under `.pipeline/` at the repo root, never loose in
the root itself.

```
.pipeline/
  product/                                  # build-project only
    PRD.md  TECH_SPEC.md
  2026-10-07-review-fix-auth-audit/         # one folder per task
    REVIEW.md  FIX_PLAN.md  IMPL_NOTES.md  HANDOFF.md
  2026-10-09-review-implement-csv-export/
    FEATURE_SPEC.md  IMPL_PLAN.md  IMPL_NOTES.md  REVIEW.md
  2026-10-12-build-project-m1-accounts/     # build-project: one folder per milestone
    PLAN.md  IMPL_NOTES.md  REVIEW.md
```

- **Task folder name:** `<YYYY-MM-DD>-<skill>-<short-kebab-slug>`, using today's date. The
  folder name is the Task ID that every agent copies into its files.
- **Every dispatch starts with `TASK_DIR: <path to the task folder>`.** The agents read and
  write pipeline files only there. When this skill says "the project root" for a pipeline
  file, it means the task folder.
- **Picking the task to resume (no argument):** look at this skill's folders (names
  containing `-<skill>-`). A task is **finished** when its plan file is fully ticked and its
  `REVIEW.md` verdict is PASS. Resume the one unfinished folder. If several are unfinished,
  ask the user which one, newest first. If none are, start a new task:
  create its folder before the first dispatch. The user can also
  name a folder directly.
- **History is kept.** Never delete or rewrite a finished task's folder, and never touch
  another task's folder. Because every run gets a fresh folder, nothing needs clearing
  before a new task starts.
- **Commit it.** `.pipeline/` is project history (specs, plans, reviews), so leave it
  tracked. Don't add it to `.gitignore`. If the repo already ignores it, leave that alone
  and mention it once.
- **Old root files (1.x layout):** before starting, check the repo root for `PLAN.md`,
  `FIX_PLAN.md`, `IMPL_PLAN.md`, `FEATURE_SPEC.md`, `REVIEW.md`, `IMPL_NOTES.md`,
  `HANDOFF.md`, `PRD.md` or `TECH_SPEC.md`. If any exist, list them and ask whether to move
  them into `.pipeline/`: plan, spec, review and notes files into a task folder named from
  their Task ID (or `<date>-legacy` without one); `PRD.md` and `TECH_SPEC.md` into
  `.pipeline/product/`. Use `git mv` for tracked files. **Never move anything without a
  yes**: a root `PRD.md` or `PLAN.md` may be the project's own document, not a pipeline
  file. If the user declines, leave them where they are and work in `.pipeline/` anyway.

## Artifacts (single source of truth, written to the task folder)

- `FEATURE_SPEC.md` — the scoped feature: what it does, the relevant existing files,
  where the new code hooks in, constraints, open questions, and acceptance criteria.
- `IMPL_PLAN.md` — an ordered **checklist** derived from the spec. Each item:
  `- [ ] T-00N — summary` followed by a 1–3 line implementation note and the files it
  touches. Items grouped into **batches** each with a `Complexity` field
  (MECHANICAL / GUIDED / STRUCTURAL) set by `task-planner`.
- `IMPL_NOTES.md` — appended per implement pass: what was built, per item.
- `REVIEW.md` — the reviewer's verdict (PASS / FAIL / CONDITIONAL_PASS) with findings.
- `HANDOFF.md` — written by `junior-code-writer` if it runs out of context mid-batch;
  signals that remaining items in that batch must be routed to `code-writer` (senior).

Each run gets its own task folder (see **Where the files live**), so nothing needs
clearing before a new task starts.

## Modes

Dispatch on the argument; with no argument, **infer the phase** from which artifacts exist in the task folder being resumed
and continue (no artifacts → `scope`; `FEATURE_SPEC.md` only → `plan`; `IMPL_PLAN.md` with
unchecked items → `next`; all items checked → `review`).

### `scope`
1. Read `AGENTS.md` / `CLAUDE.md` (and any repo architecture/contract docs) for context.
2. Delegate scoping to `code-reviewer` in its feature-scoping (scope) mode. Read-only: no
   edits. Instruct it to map the relevant parts of the codebase and write `FEATURE_SPEC.md`.
3. Summarize the spec to the user and surface any open questions via
   `the available user-input mechanism`; stop for direction unless they said to proceed
   straight through. When you batch questions, always leave room for the user to raise
   something you didn't ask about.

### `plan`
1. Delegate to `task-planner` via Codex collaboration subagent tools, pointing it at
   `FEATURE_SPEC.md`. Instruct it to produce `IMPL_PLAN.md`: ordered checklist, grouped into
   batches, each with a `Complexity` field (MECHANICAL / GUIDED / STRUCTURAL). Batch size
   follows `task-planner`'s own rules — ~3–5 related items for GUIDED and STRUCTURAL, and
   **at least 5** for MECHANICAL. Do not ask for a specific size; let the classification
   drive it.
2. Require that each item get a short, concrete implementation note, the exact files to
   touch, and — for MECHANICAL batches — inline code pattern quotes.
3. Relay any per-item user overrides into the planner's dispatch message. Do not implement yet.

### `next`

**Batch Routing — apply this every time before dispatching:**

```
1. Check if HANDOFF.md exists in the task folder
   → YES: dispatch remaining items to code-writer (senior) [see Handoff Handling below]
   → NO: continue to step 2

2. Read the first unchecked batch's Complexity field from IMPL_PLAN.md:
   → MECHANICAL: dispatch to junior-code-writer
   → GUIDED or STRUCTURAL: dispatch to code-writer (senior)

3. Fix rounds (verdict is FAIL or CONDITIONAL_PASS in REVIEW.md):
   → ALWAYS dispatch to code-writer (senior), regardless of which agent ran the original batch
```

**Dispatching to junior-code-writer (MECHANICAL):**
- Tell junior: `TASK_DIR`, the plan file name (`IMPL_PLAN.md`), the batch number to implement, and whether `FEATURE_SPEC.md` and `AGENTS.md` / `CLAUDE.md` are present. Junior reads all files from disk via its own tools — do not paste file contents into the message.
- Do NOT mention REVIEW.md in the message unless you have confirmed there is no active FAIL/CONDITIONAL_PASS verdict — junior refuses fix mode and will stop if it sees one.

**Dispatching to code-writer (GUIDED / STRUCTURAL / fix rounds):**
- Tell code-writer: `TASK_DIR`, the plan file name (`IMPL_PLAN.md`), the batch number (or "fix round" and the REVIEW.md verdict), and whether `FEATURE_SPEC.md` and `AGENTS.md` / `CLAUDE.md` are present. Code-writer reads all files from disk via its own tools — do not paste file contents into the message.

**After any sub-agent returns:**
- Check for `HANDOFF.md` — if present, see Handoff Handling below before ticking items
- If no HANDOFF.md and batch succeeded: tick those items in `IMPL_PLAN.md`, append what was built to `IMPL_NOTES.md`
- Surface any blocked items to the user via `the available user-input mechanism` before continuing
- Report the batch result and stop so the user can test between batches

**Handoff Handling (HANDOFF.md exists):**
- `junior-code-writer` ran out of context mid-batch and wrote `HANDOFF.md`
- Tell `code-writer` (senior): `HANDOFF.md` exists in `TASK_DIR`, the plan file name (`IMPL_PLAN.md`), and the batch number. Code-writer reads `HANDOFF.md` and all other files from disk via its own tools.
- `code-writer` will complete the remaining items and delete `HANDOFF.md` on success
- On senior completion: tick ALL items in the batch (both junior's completed items and senior's completion)
- Do not re-run the completed items listed in `HANDOFF.md`

### `review`
1. Delegate to `code-reviewer` in verdict (audit) mode: check the implemented diff against
   `IMPL_PLAN.md` and `FEATURE_SPEC.md`. It writes `REVIEW.md`.
2. On FAIL/CONDITIONAL_PASS: each BLOCKER/MAJOR finding becomes a **new unchecked item**
   appended to `IMPL_PLAN.md` — then it's `next` again (routed to senior code-writer via
   fix round routing), followed by `rereview`.

### `rereview`
1. Delegate to `code-reviewer` to verify each prior finding was actually resolved; update
   `REVIEW.md` verdicts.
2. Any regressions or incomplete items become new unchecked items in `IMPL_PLAN.md` — then
   `next` again. Cap fix-rounds at 2 before escalating to the user.

### `status`
Print a compact progress view: which artifact phase the pipeline is in, item counts,
batches done / remaining, the latest review verdict, and whether HANDOFF.md is present.

## Feedback & escalation (how you and the sub-agents reach the user)

Sub-agents launched via Codex collaboration subagent tools **cannot talk to the user directly** —
each runs to completion and returns one final message to you, the orchestrator. So questions
reach the user only if **you** relay them.

- **Check every sub-agent's return before continuing.** Scan its output and the artifact
  it wrote for: **Blocked Items** or open questions in `IMPL_NOTES.md` / `FEATURE_SPEC.md`,
  a `HANDOFF.md` requiring senior handoff, an **escalation / two-fix-rounds-cap** stop, or
  BLOCKER findings the user should weigh in on. If any are present, **stop the pipeline** and
  put them to the user via `the available user-input mechanism`.
- **Route genuine forks through `the available user-input mechanism`.** Any real decision is a
  structured question with a **recommended option first** and your reasoning, not a silent pick.
- **Don't invent answers to unblock.** If a sub-agent blocked an item for a real ambiguity,
  the fix is to ask the user — not to guess so the pipeline keeps moving.

## Rules

- **Never re-request context that lives in `AGENTS.md` / `CLAUDE.md` or repo docs.** Read it.
- `scope` and `plan` make no code changes.
- In `scope`, open questions and assumptions go in `FEATURE_SPEC.md` and get resolved with
  the user **before** planning — a plan built on an unresolved assumption is a plan nobody
  signed off on.
- Keep dispatch messages to sub-agents scoped to one batch.
- State is the files. If interrupted, resuming is just re-invoking the skill in the repo.

## Engineering guardrails (apply at every phase)

1. **Think before coding.** In `scope` and `plan`, state assumptions explicitly. If the
   feature has multiple plausible designs, present the options with a recommendation — don't
   pick silently.
2. **Simplicity first.** "Minimum that works" means the minimum that satisfies the spec's
   acceptance criteria — not the minimum that compiles.
3. **Surgical changes.** Every changed line in a batch must trace to a specific item ID.
   Pass this rule to `code-writer` verbatim. Pre-existing dead code gets *mentioned* in
   `IMPL_NOTES.md`, never deleted as a drive-by.
4. **Goal-driven execution.** Each `IMPL_PLAN.md` item must carry a binary verification.
   A batch isn't ticked until its items' checks were actually run and passed.
