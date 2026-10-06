---
name: review-fix
description: Run a full codebase review and drive the fixes to completion as a resumable, file-backed pipeline. Use when the user asks to "review this codebase", "do a full code review", "plan the fixes", "implement the fix plan", "copy the plan to an md file", or otherwise wants the review → fix-plan → per-fix implementation → re-review loop. Carries state in in-repo markdown files (REVIEW.md, FIX_PLAN.md, IMPL_NOTES.md) so a fresh session resumes from the files instead of a re-pasted mega-prompt.
---

# review-fix

> **Agent names:** the sub-agents ship in the `development-pipeline` plugin, so their
> registered names are `development-pipeline:task-planner`, `development-pipeline:code-reviewer`,
> `development-pipeline:code-writer` and `development-pipeline:junior-code-writer`. Always pass
> the full prefixed name as `subagent_type`, even where this file says just `code-writer` etc.

A resumable pipeline for the recurring "review a codebase, plan the fixes, implement
them one prompt at a time, review again" workflow. It exists to kill three specific
failure modes seen repeatedly in past sessions:

1. **Re-pasted mega-prompts** — a fresh session per fix, each re-attaching architecture
   docs. Fix: **state lives in files** (`REVIEW.md`, `FIX_PLAN.md`, `IMPL_NOTES.md`),
   and project context comes from `CLAUDE.md`. Never ask the user to re-paste context
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
- **You MUST** launch the sub-agents via the Agent tool:
  - `review`/`rereview` → `Agent(subagent_type: "development-pipeline:code-reviewer", prompt: …)`
  - `plan` → `Agent(subagent_type: "development-pipeline:task-planner", prompt: …)`
  - `next` → route per batch Complexity (see **Batch Routing** below)
- **Self-check before every phase**: if you are about to Read more than a handful of
  source files, or about to write findings/plan/code text yourself, stop — that work
  belongs to a sub-agent. Compose its prompt and launch it instead.
- The only exception is when the Agent tool is unavailable or a launch fails twice;
  then say so explicitly to the user before doing anything inline.

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

## Required reading (before your first dispatch)

**Read `pipeline-core.md` (in this skill's folder) now.** It carries the rules this skill
depends on and does not repeat: handoff handling, how sub-agents escalate to the user, the
standing rules, and the Karpathy guardrails. Read it once per session, before Gate 0.

## Artifacts (single source of truth, written to the repo being worked on)

- `REVIEW.md` — findings from the review, each with an ID (`F-001`…), severity
  (BLOCKER / MAJOR / MINOR), affected files, and a one-line description.
- `FIX_PLAN.md` — an ordered **checklist**. Each item: `- [ ] F-00N (SEV) — summary`
  followed by a 1–3 line implementation note and the files it touches. Items grouped
  into **batches** (`## Batch 1`, `## Batch 2`, …) each with a `Complexity` field
  (MECHANICAL / GUIDED / STRUCTURAL) set by `task-planner`.
- `IMPL_NOTES.md` — appended per implement pass: what changed, per finding.
- `HANDOFF.md` — written by `junior-code-writer` if it runs out of context mid-batch;
  signals that remaining items in that batch must be routed to `code-writer` (senior).

If `REVIEW.md`/`FIX_PLAN.md`/`IMPL_NOTES.md` from a *previous, unrelated* task are stale,
clear them before starting a new review (task-planner already does this for its own files).

## Modes

Dispatch on the argument; with no argument, **infer the phase** from which artifacts exist
and continue (no artifacts → `review`; `REVIEW.md` only → `plan`; `FIX_PLAN.md` with
unchecked items → `next`; all items checked → `rereview`).

### `review`
1. Read `CLAUDE.md` (and any repo review/contract docs) for context.
2. Delegate the audit to `code-reviewer`. Read-only: no edits in this phase.
3. Write findings to `REVIEW.md` with stable IDs and severities. Summarize the top items
   to the user; stop for direction unless they said to proceed straight through.

### `plan`
1. Delegate to `task-planner` via the Agent tool, pointing it at `REVIEW.md`. Instruct it
   to produce `FIX_PLAN.md`: ordered checklist, grouped into batches, each with a
   `Complexity` field (MECHANICAL / GUIDED / STRUCTURAL). Batch size follows
   `task-planner`'s own rules — ~3–5 related findings for GUIDED and STRUCTURAL, and **at
   least 5** for MECHANICAL, which is why most batches land GUIDED. Do not ask for a
   specific size; let the classification drive it.
2. Require that each item get a short, concrete implementation note, the exact files to
   touch, and — for MECHANICAL batches — inline code pattern quotes (no file discovery).
3. Relay any per-item user overrides into the planner's prompt. Do not implement yet.

### `next`

**Batch Routing — apply this every time before dispatching:**

```
1. Check if HANDOFF.md exists at the project root
   → YES: dispatch remaining items to code-writer (senior) [see Handoff Handling below]
   → NO: continue to step 2

2. Read the first unchecked batch's Complexity field from FIX_PLAN.md:
   → MECHANICAL: dispatch to junior-code-writer
   → GUIDED or STRUCTURAL: dispatch to code-writer (senior)

3. Fix rounds (verdict is FAIL or CONDITIONAL_PASS in REVIEW.md):
   → ALWAYS dispatch to code-writer (senior), regardless of which agent ran the original batch
```

**Dispatching to junior-code-writer (MECHANICAL):**
- Tell junior: the plan file name (`FIX_PLAN.md`), the batch number to implement, and whether `CLAUDE.md` is present. Junior reads all files from disk via its own tools — do not paste file contents into the prompt.
- Do NOT mention REVIEW.md in the prompt unless you have confirmed there is no active FAIL/CONDITIONAL_PASS verdict — junior refuses fix mode and will stop if it sees one.

**Dispatching to code-writer (GUIDED / STRUCTURAL / fix rounds):**
- Tell code-writer: the plan file name (`FIX_PLAN.md`), the batch number (or "fix round" and the REVIEW.md verdict), and whether `FEATURE_SPEC.md` or `CLAUDE.md` are present. Code-writer reads all files from disk via its own tools — do not paste file contents into the prompt.

**After any sub-agent returns:**
- Check for `HANDOFF.md` — if present, see Handoff Handling below before ticking items
- If no HANDOFF.md and batch succeeded: tick those items in `FIX_PLAN.md`, append what changed to `IMPL_NOTES.md`
- Surface any blocked items to the user via `AskUserQuestion` before continuing
- Report the batch result and stop so the user can test between batches

**Handoff Handling (HANDOFF.md exists):** see `pipeline-core.md`.

### `rereview`
1. Delegate to `code-reviewer` to verify each fixed finding actually resolved; update
   `REVIEW.md` verdicts.
2. Any regressions or incomplete fixes become **new unchecked items** appended to
   `FIX_PLAN.md` — then it's `next` again. Cap fix-rounds at 2 before escalating to the
   user (matches the trio's guardrail).

### `status`
Print a compact progress view: total findings by severity, batches done / remaining,
which artifact phase the pipeline is in, and whether HANDOFF.md is present.

## Feedback, rules, and guardrails

See `pipeline-core.md` (in this skill's folder) — escalation protocol, standing rules, and
the Karpathy guardrails. Two additions specific to this skill:

- In `plan`, state assumptions explicitly. If a finding has multiple plausible fixes,
  present the options with a recommendation — never pick one silently. When that goes out as
  a batch of questions, reserve one of the four `AskUserQuestion` slots for open user input —
  see **Reserve a slot for the user** in `pipeline-core.md`.
- The fix is the *minimum* change that resolves the finding. Every changed line must trace
  to a specific finding ID, and pre-existing dead code gets mentioned in `REVIEW.md`,
  never deleted as a drive-by.
