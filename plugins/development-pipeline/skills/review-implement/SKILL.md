---
name: review-implement
description: Scope a new feature against the codebase and drive it to a working implementation as a resumable, file-backed pipeline. Use when the user asks to "add a feature", "build this feature", "scope this out", "plan the feature", "implement the feature plan", "spec a new capability", or otherwise wants the scope → feature-plan → per-batch implementation → review loop for NEW functionality (not bug fixes — use review-fix for those). Carries state in in-repo markdown files (FEATURE_SPEC.md, IMPL_PLAN.md, IMPL_NOTES.md, REVIEW.md) so a fresh session resumes from the files instead of a re-pasted mega-prompt.
---

# review-implement

> **Agent names:** the sub-agents ship in the `development-pipeline` plugin, so their
> registered names are `development-pipeline:task-planner`, `development-pipeline:code-reviewer`,
> `development-pipeline:code-writer` and `development-pipeline:junior-code-writer`. Always pass
> the full prefixed name as `subagent_type`, even where this file says just `code-writer` etc.

A resumable pipeline for the recurring "scope a new feature, plan it, build it one
batch at a time, review it" workflow. It is the sibling of `review-fix`: same machinery,
but the input is a **feature request** and the output is **new functionality**, not a set
of fixes. It exists to kill three specific failure modes:

1. **Re-pasted mega-prompts** — a fresh session per batch, each re-attaching architecture
   docs and the feature description. Fix: **state lives in files** (`FEATURE_SPEC.md`,
   `IMPL_PLAN.md`, `IMPL_NOTES.md`), and project context comes from `CLAUDE.md`.
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
  `IMPL_NOTES.md`/`REVIEW.md` content yourself, or use Edit/Write on any source or test
  file. Your only direct writes are ticking checkboxes in `IMPL_PLAN.md` and small
  bookkeeping edits to the artifacts the sub-agents produced.
- **You MUST** launch the sub-agents via the Agent tool:
  - `scope` → `Agent(subagent_type: "development-pipeline:code-reviewer", prompt: …)`
  - `plan` → `Agent(subagent_type: "development-pipeline:task-planner", prompt: …)`
  - `next` → route per batch Complexity (see **Batch Routing** below)
  - `review`/`rereview` → `Agent(subagent_type: "development-pipeline:code-reviewer", prompt: …)`
- **Self-check before every phase**: if you are about to Read more than a handful of
  source files, or about to write spec/plan/code text yourself, stop — that work belongs
  to a sub-agent. Compose its prompt and launch it instead.
- The only exception is when the Agent tool is unavailable or a launch fails twice; then
  say so explicitly to the user before doing anything inline.

## Required reading (before your first dispatch)

**Read `pipeline-core.md` (in this skill's folder) now.** It carries the rules this skill
depends on and does not repeat: where the files live (`.pipeline/`), handoff handling, how sub-agents escalate to the user, the
standing rules, and the engineering guardrails. Read it once per session, before Gate 0.

## Gate 0 — is the pipeline worth it? (new features only; skip on resume)

A full pass is four sub-agent invocations (scope → plan → implement → review), two of them
on the pipeline's most expensive tier. That is the right price for real feature work and
the wrong price for a small one.

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
1. Read `CLAUDE.md` (and any repo architecture/contract docs) for context.
2. Delegate scoping to `code-reviewer` in its feature-scoping mode, **overriding its model
   to the mid-tier general-purpose one on the Agent call** — pass `model: "sonnet"`.
   Read-only: no edits. Instruct it to map the relevant parts of the codebase and write
   `FEATURE_SPEC.md`.

   Scope mode is codebase mapping and writing, not defect judgement, so it does not need
   the deeper-reasoning tier the agent's frontmatter selects by default. The
   per-invocation `model` parameter outranks that frontmatter, so this one call runs
   cheaper while `review` and `rereview` below keep the expensive default. Do **not**
   pass `model` on those.

   That alias is the only model name in this file, and it is a config value rather than
   prose — if the alias set changes, this is the single line to update.
3. Summarize the spec to the user and surface any open questions; stop for direction
   unless they said to proceed straight through. If you put those questions as an
   `AskUserQuestion` batch, one of the four slots is reserved for whatever the user wants to
   raise — see **Reserve a slot for the user** in `pipeline-core.md`.

### `plan`
1. Delegate to `task-planner` via the Agent tool, pointing it at `FEATURE_SPEC.md`.
   Instruct it to produce `IMPL_PLAN.md`: ordered checklist, grouped into batches, each
   with a `Complexity` field (MECHANICAL / GUIDED / STRUCTURAL). Batch size follows
   `task-planner`'s own rules — ~3–5 related items for GUIDED and STRUCTURAL, and **at
   least 5** for MECHANICAL, which is why most batches land GUIDED. Do not ask for a
   specific size; let the classification drive it.
2. Require that each item get a short, concrete implementation note, the exact files to
   touch, and — for MECHANICAL batches — inline code pattern quotes.
3. Relay any per-item user overrides into the planner's prompt. Do not implement yet.

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
- Tell junior: `TASK_DIR`, the plan file name (`IMPL_PLAN.md`), the batch number to implement, and whether `FEATURE_SPEC.md` and `CLAUDE.md` are present. Junior reads all files from disk via its own tools — do not paste file contents into the prompt.
- Do NOT mention REVIEW.md in the prompt unless you have confirmed there is no active FAIL/CONDITIONAL_PASS verdict — junior refuses fix mode and will stop if it sees one.

**Dispatching to code-writer (GUIDED / STRUCTURAL / fix rounds):**
- Tell code-writer: `TASK_DIR`, the plan file name (`IMPL_PLAN.md`), the batch number (or "fix round" and the REVIEW.md verdict), and whether `FEATURE_SPEC.md` and `CLAUDE.md` are present. Code-writer reads all files from disk via its own tools — do not paste file contents into the prompt.

**After any sub-agent returns:**
- Check for `HANDOFF.md` — if present, see Handoff Handling below before ticking items
- If no HANDOFF.md and batch succeeded: tick those items in `IMPL_PLAN.md`, append what was built to `IMPL_NOTES.md`
- Surface any blocked items to the user via `AskUserQuestion` before continuing
- Report the batch result and stop so the user can test between batches

**Handoff Handling (HANDOFF.md exists):** see `pipeline-core.md`.

### `review`
1. Delegate to `code-reviewer` in verdict mode: check the implemented diff against
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

## Feedback, rules, and guardrails

See `pipeline-core.md` (in this skill's folder) — escalation protocol, standing rules, and
the engineering guardrails. Two additions specific to this skill:

- In `scope`, open questions and assumptions go in `FEATURE_SPEC.md` and get resolved with
  the user **before** planning — a plan built on an unresolved assumption is a plan nobody
  signed off on.
- "Minimum that works" here means the minimum that satisfies the spec's acceptance
  criteria — not the minimum that compiles.
