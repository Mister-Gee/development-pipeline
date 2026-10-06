---
name: build-project
description: Take a new product/project from a raw idea to working code as a resumable, file-backed pipeline. Use when the user wants to "start a new project", "build a new app", "I have an idea for…", "let's brainstorm a product", "spec out a new feature/product", or otherwise wants the brainstorm → PRD → tech spec → plan → build → review loop. Brainstorms interactively with the user, writes PRD.md and TECH_SPEC.md, then hands off to task-planner → code-writer or junior-code-writer (per batch complexity) → code-reviewer (with fix rounds). Carries state in in-repo markdown files so a fresh session resumes from the files instead of re-explaining the idea.
---

# build-project

> **Agent names:** the sub-agents ship in the `development-pipeline` plugin, so their
> registered names are `development-pipeline:task-planner`, `development-pipeline:code-reviewer`,
> `development-pipeline:code-writer` and `development-pipeline:junior-code-writer`. Always pass
> the full prefixed name as `subagent_type`, even where this file says just `code-writer` etc.

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
- **Back half (sub-agents only, via the Agent tool)**:
  - `plan` → `Agent(subagent_type: "development-pipeline:task-planner", prompt: points at PRD.md + TECH_SPEC.md)`
  - `build` → route per batch Complexity (see **Batch Routing** below), then
    `Agent(subagent_type: "development-pipeline:code-reviewer", prompt: …)`; fix rounds route to `code-writer` (senior)
- **You MUST NOT** author `PLAN.md`/`IMPL_NOTES.md`/`REVIEW.md` yourself, and MUST NOT
  use Edit/Write on any source or test file — not even scaffolding "to get things started."
- **Self-check at the plan gate**: the moment `TECH_SPEC.md` is confirmed, your next
  action is an Agent tool call to `task-planner` — not writing steps yourself.
- The only exception is when the Agent tool is unavailable or a launch fails twice;
  then say so explicitly to the user before doing anything inline.

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

## Required reading (before your first back-half dispatch)

**Read `pipeline-core.md` (in this skill's folder) now.** It carries the rules this skill
depends on and does not repeat: handoff handling, how sub-agents escalate to the user, the
standing rules, and the Karpathy guardrails.

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
3. Use `AskUserQuestion` for genuine forks — offer a recommended option first, and keep one
   of the four slots open for whatever the user wants to raise.
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
- Tell junior: the plan file name (`PLAN.md`), the batch number to implement, and whether `CLAUDE.md` is present. Junior reads all files from disk via its own tools — do not paste file contents into the prompt.
- Do NOT mention REVIEW.md in the prompt unless you have confirmed there is no active FAIL/CONDITIONAL_PASS verdict — junior refuses fix mode and will stop if it sees one.

**Dispatching to code-writer (GUIDED / STRUCTURAL / fix rounds):**
- Tell code-writer: the plan file name (`PLAN.md`), the batch number (or "fix round" and the REVIEW.md verdict), and whether `TECH_SPEC.md` and `CLAUDE.md` are present. Code-writer reads all files from disk via its own tools — do not paste file contents into the prompt.

**Review cadence: per milestone, not per batch.**

A full `code-reviewer` pass runs on the most expensive model in the pipeline — it is the
deepest-reasoning agent you dispatch. Firing one after every batch multiplies that by
the batch count for a verdict that can only be partial anyway — a milestone's batches are
interdependent, so batch 2 often changes what the right call on batch 1 was. Review once,
when the milestone is complete and reviewable as a whole.

**After each batch returns (cheap gate — no reviewer):**
- Check for `HANDOFF.md` — if present, see Handoff Handling before continuing
- Run the plan's **full verification commands yourself** with Bash and read the exit codes
- **Green** → tick the batch's items in `PLAN.md` and continue to the next batch
- **Red** → stop. Do not start the next batch on a broken tree. Send it straight back to
  `code-writer` (senior) with the failing output, or surface it to the user if the failure
  looks like a plan defect rather than an implementation defect
- Surface any Blocked Items from `IMPL_NOTES.md` to the user before continuing

**After the last batch in a milestone (full gate):**
- Delegate to `code-reviewer` → `REVIEW.md`, covering the whole milestone's diff
- On FAIL / CONDITIONAL_PASS: send findings back to `code-writer` (senior) in fix mode, then re-review
- **Cap at 2 fix rounds** before escalating to the user (the trio's own guardrail)
- On PASS: advance to the next milestone's `plan` → `build` until the spec is delivered

Keep milestones small enough that one review at the end is still a review of something
reviewable. If a milestone has grown to where its diff is too large to audit as a unit,
that is a signal to split the milestone in `plan` — not to add review rounds inside it.

**Handoff Handling (HANDOFF.md exists):** see `pipeline-core.md`. After senior
completes, proceed with the normal cadence above — the cheap gate if batches remain in the
milestone, the full `code-reviewer` gate if it was the last one.

### `status`
Compact progress view: which phase the pipeline is in, milestones planned / built / passed,
any open questions still parked in `PRD.md`, and whether `HANDOFF.md` is present.

## Feedback, rules, and guardrails

See `pipeline-core.md` (in this skill's folder) — escalation protocol, standing rules, and
the Karpathy guardrails. The front half of this skill adds four of its own:

- **The front half is interactive by design.** Use `AskUserQuestion` for genuine forks and
  confirm at each gate before writing `PRD.md` or `TECH_SPEC.md`. Every `brainstorm` and
  `spec` question batch reserves one of its four slots for open user input — see **Reserve
  a slot for the user** in `pipeline-core.md`.
- **Files are the memory.** Never re-request an idea that already lives in `PRD.md` or
  `TECH_SPEC.md`. Resuming is re-invoking the skill in the project directory.
- **Don't skip ahead.** No stack decisions during `brainstorm`; no code before `PLAN.md`.
- **v1 is the minimum product that tests the riskiest assumption** — prefer boring
  architecture with few moving parts, and push back if a simpler product would do.

New empty project? Offer to scaffold the repo and a starter `CLAUDE.md` once `TECH_SPEC.md`
is settled.
