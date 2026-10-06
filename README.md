# development-pipeline

Resumable, file-backed software pipelines for **Claude Code** and **Codex**. A main agent
orchestrates, and dedicated sub-agents plan, write and review the code. All state lives in
markdown files inside your repo, so any fresh session picks up where the last one stopped.

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

Existing files with the same names are skipped unless you pass `--force`. Before the npm
release, the same command works straight from GitHub:
`npx github:Mister-Gee/development-pipeline`.

## Install: Claude Code (plugin)

```
/plugin marketplace add Mister-Gee/development-pipeline
/plugin install development-pipeline@development-pipeline
```

Then run `/build-project`, `/review-fix` or `/review-implement` in your repo. The sub-agents
are registered as `development-pipeline:task-planner`, `development-pipeline:code-writer`, etc.

Model choices are in each agent's frontmatter (`plugins/development-pipeline/agents/*.md`):
`opus` for planner, writer and reviewer, `haiku` for the junior writer.

## Install: Codex

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

Re-invoke the same skill in the same repo. With no argument, each skill infers its phase from
which state files exist. Each also accepts an explicit phase (for example `review-fix plan`,
`review-implement next`, `review-fix status`).

## License

MIT © 2026 Gbenga Fakuade. See [LICENSE](LICENSE).
