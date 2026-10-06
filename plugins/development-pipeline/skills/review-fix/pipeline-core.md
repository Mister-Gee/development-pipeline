# Pipeline Core

Shared rules for the `review-fix`, `review-implement`, and `build-project` skills. Each of
those skills instructs you to read this file before its first dispatch. Everything here
applies to all three; anything skill-specific (Gate 0, Modes, Batch Routing) stays in the
skill itself.

Where this file says **"the plan file"**, read it as whichever the calling skill uses:
`FIX_PLAN.md` (review-fix), `IMPL_PLAN.md` (review-implement), or `PLAN.md` (build-project).

---

## Naming models (a convention for these files)

**Instructions describe tiers; only configuration names models.** Model names change with
every release, so prose that says "runs on <model>" is wrong the moment the assignment
moves — and wrong prose about cost quietly misleads whoever edits it next.

- **In prose**, describe the tier and why it matters: "the pipeline's most expensive tier",
  "the deepest-reasoning agent you dispatch", "the mid-tier general-purpose model". A
  reader learns what the sentence is actually about — relative cost and relative capability
  — which stays true across releases.
- **In configuration**, use the real value: each agent's `model:` frontmatter, and the one
  per-invocation `model` parameter in review-implement's `scope` phase. These have to name
  something the harness resolves, so they name it.

Which agent sits on which tier lives in that agent's own frontmatter — the single source of
truth. Don't restate an assignment in prose; describe the consequence instead.

---

## Cost-efficient routing (apply at plan and dispatch)

The cheapest-tier writer (`junior-code-writer`) only runs batches `task-planner` tagged
MECHANICAL, and refuses GUIDED, STRUCTURAL, and **every fix round**. You don't pick it at
dispatch — you shape how much work legitimately lands in the MECHANICAL bucket, and you keep
it from failing. A junior batch that hands off or stalls costs the cheap-tier spend **and** a
senior redo: the worst outcome. So:

- **Savings live at plan time, not dispatch time.** When you review the plan, check whether a
  GUIDED batch is genuinely GUIDED or just under-specified. If a batch is only GUIDED because
  a note says "update the callers accordingly", the fix is to do that discovery once, then
  have `task-planner` re-emit the now-known edits as a MECHANICAL batch with inline
  code-pattern quotes. Don't force GUIDED work onto junior — that produces handoffs, not
  savings.
- **Keep MECHANICAL batches junior-sized.** Junior reads at most ~5 files and hands off if it
  runs long. A "mechanical" batch spanning many files was mis-sized — that's a planning fix.
  Batching similar rote edits together also helps them clear the planner's ≥5-item MECHANICAL
  threshold instead of being absorbed into a GUIDED batch.
- **Never show junior an active failing verdict.** Confirm there is no active
  FAIL/CONDITIONAL_PASS before dispatching — junior refuses fix mode and stops, wasting the
  spend (already stated per-skill; it is a cost rule too).
- **The reviewer, not the writer, is the dominant cost.** A `code-reviewer` pass runs on the
  deepest-reasoning tier. Review **per milestone, not per batch** — one avoided reviewer pass
  saves more than any amount of writer-tier tuning. Optimize the reviewer cadence first.

---

## Handoff Handling (when HANDOFF.md exists)

`junior-code-writer` ran out of context mid-batch and wrote `HANDOFF.md`. The remaining
items go to `code-writer` (senior) — never back to junior, which refuses take-over mode.

- Tell `code-writer`: `HANDOFF.md` exists at the project root, the plan file name, and the
  batch number. **Code-writer reads `HANDOFF.md` and every other file from disk via its own
  tools — do not paste file contents, item text, or file lists into the prompt.**
- `code-writer` completes the remaining items and deletes `HANDOFF.md` on success
- Do not re-run the items `HANDOFF.md` lists as completed — they are done
- Once the batch is finished, tick **all** of its items: junior's completed ones and
  senior's together

---

## Feedback & escalation (how the sub-agents reach the user)

Sub-agents launched via the Agent tool **cannot talk to the user**. `AskUserQuestion` is
removed from every sub-agent unconditionally, and each one runs to completion and returns a
single message to you. So a question reaches the user only if **you** relay it.

- **Check every sub-agent's return before continuing.** Scan both its final message and the
  artifact it wrote for: open questions in `FEATURE_SPEC.md`, **Blocked Items** in
  `IMPL_NOTES.md`, a `HANDOFF.md` needing senior handoff, an escalation or two-fix-rounds
  stop, or BLOCKER findings the user should weigh in on. If any are present, **stop the
  pipeline** and put them to the user via `AskUserQuestion`.
- **Route genuine forks through `AskUserQuestion`** — a structured question with your
  recommended option first and your reasoning, never a silent pick.
- **Sub-agents surface questions through files.** `code-reviewer` records open questions in
  `FEATURE_SPEC.md` and findings in `REVIEW.md`; both writers record blocked items in
  `IMPL_NOTES.md`; `junior-code-writer` records handoffs in `HANDOFF.md`. Reading those and
  relaying the open ones is your job, every round.
- **Don't invent answers to unblock.** If a sub-agent blocked an item over a real ambiguity,
  the fix is to ask the user — not to guess so the pipeline keeps moving.

### Reserve a slot for the user (interactive phases only)

A batch of questions you wrote can only surface forks *you* already thought of. So when an
interactive phase — build-project's `brainstorm` and `spec`, review-implement's `scope`, and
any batch of fix-choice questions review-fix's `plan` puts to the user — sends **more than
one question in a call**, spend at most three slots on your own forks and give the remaining
one to the user:

- header: `Your call` (or `Anything else`)
- question: "Anything I haven't asked about — a concern, a constraint, or a question of your
  own?"
- options: "Nothing — carry on" first, as the low-friction default, then "I have a question"
  and "I want to change something you've already decided"

`AskUserQuestion` accepts **at most 4 questions per call** — this is one of those four
reserved, never a fifth appended. Each question carries 2–4 options and the harness adds
"Other" itself, so never author an "Other" option.

If the user picks anything other than "carry on", **resolve it before moving to the next
phase** — it is a fork, and the answer may change the artifact you were about to write.

Scope: question *batches* in those phases only. A single clarifying question mid-plan or
mid-implementation stays a single question.

---

## Rules

- **Never re-request context that already lives in the repo.** `CLAUDE.md`, the artifacts,
  and repo docs are the context. Read them; don't ask the user to re-paste them.
- **Look before you edit.** The read-only phases (`scope`, `review`, `plan`) make no code
  changes.
- **Keep every sub-agent prompt scoped to one batch**, and name files rather than pasting
  their contents — every agent has its own Read tool.
- **State is the files.** If interrupted, resuming is just re-invoking the skill in the repo.

---

## Karpathy guardrails (apply at every phase)

1. **Think before coding.** Surface assumptions and genuine forks explicitly, in the
   artifact and to the user. If something is confusing, say so rather than planning
   around it.
2. **Simplicity first.** Plan and build the *minimum* that satisfies the goal — no
   speculative abstractions, no unrequested configurability, no error handling for
   impossible scenarios. If a simpler approach exists, say so before building the
   complicated one.
3. **Surgical changes.** Every changed line in a batch must trace to a specific plan item.
   Pass this rule to the writers verbatim. A change orphaning its own imports or variables
   cleans them up; pre-existing dead code gets *mentioned*, never deleted.
4. **Goal-driven execution.** Every item carries a binary verification. A batch is not
   ticked until its checks were actually run and passed — not until an agent reports that
   they were.
