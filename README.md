# development-pipeline

[![npm](https://img.shields.io/npm/v/development-pipeline)](https://www.npmjs.com/package/development-pipeline)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Resumable, file-backed software pipelines for **Claude Code** and **Codex**. A main agent
orchestrates, and dedicated sub-agents plan, write and review the code. All state lives in
markdown files under `.pipeline/` in your repo, so any fresh session picks up where the last
one stopped, and your project root stays clean.

| Skill | Use it for | State files |
|---|---|---|
| `build-project` | New product from a raw idea: brainstorm → PRD → tech spec → plan → build → review | `PRD.md`, `TECH_SPEC.md`, `PLAN.md`, `IMPL_NOTES.md`, `REVIEW.md` |
| `review-fix` | Audit an existing codebase and fix what it finds | `REVIEW.md`, `FIX_PLAN.md`, `IMPL_NOTES.md` |
| `review-implement` | Add a new feature to an existing codebase | `FEATURE_SPEC.md`, `IMPL_PLAN.md`, `IMPL_NOTES.md`, `REVIEW.md` |

| Sub-agent | Role |
|---|---|
| `task-planner` | Writes the batched plan, tagging each batch MECHANICAL / GUIDED / STRUCTURAL |
| `code-writer` | Senior implementer: GUIDED and STRUCTURAL batches, every fix round, junior handoffs |
| `junior-code-writer` | Cheap implementer for MECHANICAL batches only |
| `code-reviewer` | Audits the diff (PASS / FAIL / CONDITIONAL_PASS); also scopes features into `FEATURE_SPEC.md` |

## Where the files go

Since 2.0, everything goes into a `.pipeline/` folder, one subfolder per task:

```
.pipeline/
  product/                                # build-project: PRD.md, TECH_SPEC.md
  20261007-review-fix-auth-audit/         # REVIEW.md, FIX_PLAN.md, IMPL_NOTES.md
  20261009-review-implement-csv-export/   # FEATURE_SPEC.md, IMPL_PLAN.md, IMPL_NOTES.md, REVIEW.md
  20261012-build-project-m1-accounts/     # PLAN.md, IMPL_NOTES.md, REVIEW.md (one per milestone)
```

- Finished task folders are kept as history, and two tasks can run side by side.
- `.pipeline/` is git-ignored: the skill adds it to `.gitignore` the first time. Reviews can
  describe security problems that aren't fixed yet, so they shouldn't reach a public repo.
  Remove the line if you want the files tracked; the skill won't add it back.
- Older tasks whose files sit at the repo root (1.x) keep working where they are. The skill
  offers once to move them into `.pipeline/` and never moves anything without a yes.
- Every agent must be told its task folder, and refuses to start without one. After each
  agent returns, the skill checks the files landed in that folder and moves any strays.

## Install with npx (Claude Code and/or Codex)

```bash
npx development-pipeline
```

By default this installs for every tool it finds (`~/.claude`, `~/.codex`). Options:

| Flag | Effect |
|---|---|
| `--claude` / `--codex` | Install for just that tool |
| `--project` | Claude Code only: install into `./.claude` of the current repo |
| `--force` | Overwrite skills or agents that already exist with the same names |
| `uninstall` | Remove everything this package installed (`npx development-pipeline uninstall`) |

Examples:

```bash
npx development-pipeline --claude            # Claude Code only, user-wide
npx development-pipeline --claude --project  # Claude Code only, this repo
npx development-pipeline --codex             # Codex only
npx development-pipeline@latest --force      # upgrade an existing install
```

Existing files with the same names are skipped unless you pass `--force`. Restart Claude Code
or Codex after installing. Requires Node.js 18+.

The npx install puts the agents under their plain names (`code-writer`, …). The plugin
install below registers them as `development-pipeline:code-writer`, …. Use one method, not both.

## Install: Claude Code (plugin)

```
/plugin marketplace add Mister-Gee/development-pipeline
/plugin install development-pipeline@development-pipeline
```

Then run `/build-project`, `/review-fix` or `/review-implement` in your repo. The sub-agents
are registered as `development-pipeline:task-planner`, `development-pipeline:code-writer`, etc.

Model choices are in each agent's frontmatter (`plugins/development-pipeline/agents/*.md`):
`opus` for planner, writer and reviewer, `haiku` for the junior writer.

## Install: Codex (without npm)

```bash
git clone https://github.com/Mister-Gee/development-pipeline
cd development-pipeline/codex
sh install.sh                 # macOS / Linux / Git Bash
```

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1   # Windows
```

This copies the skills to `~/.codex/skills/` and the agent roles to `~/.codex/agents/`
(or `$CODEX_HOME`), and writes your agents path into each skill. Restart Codex, then invoke
`$build-project`, `$review-fix` or `$review-implement`.

The Codex agent roles set `model = "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna"` in
`codex/agents/*.toml`. Edit those lines if your account uses different models.

## Resuming

Re-invoke the same skill in the same repo:

- **No argument:** resumes the skill's one unfinished task, asking if there are several.
- **A task name, or part of one:** `/review-fix auth` resumes `.pipeline/20261007-review-fix-auth-audit/`.
  It works for finished or abandoned tasks too. `root` picks an older task at the repo root.
  If nothing matches, the text is treated as a new request.
- **A phase:** `/review-fix plan`, `/review-implement next`, `/review-fix status`. It can be
  combined with a name: `/review-fix auth status`.

## License

MIT © 2026 Gbenga Fakuade. See [LICENSE](LICENSE).
