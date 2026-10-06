#!/usr/bin/env node
// development-pipeline installer: copies the skills and sub-agents into Claude Code and/or Codex.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(PKG_ROOT, 'plugins', 'development-pipeline');
const CODEX_SRC = path.join(PKG_ROOT, 'codex');
const SKILLS = ['build-project', 'review-fix', 'review-implement'];
const AGENTS = ['task-planner', 'code-writer', 'junior-code-writer', 'code-reviewer'];
const VERSION = require(path.join(PKG_ROOT, 'package.json')).version;

const HELP = `development-pipeline v${VERSION}

Usage:
  npx development-pipeline [install] [options]
  npx development-pipeline uninstall [options]

Targets (default: every tool found on this machine; both if neither is found):
  --claude          Claude Code  (~/.claude/skills, ~/.claude/agents)
  --codex           Codex        ($CODEX_HOME or ~/.codex)

Options:
  --project         Claude Code only: install into ./.claude in the current directory
  --force           Overwrite skills/agents that already exist with the same name
  -h, --help        Show this help
  -v, --version     Show the version

Skills installed: ${SKILLS.join(', ')}
Agents installed: ${AGENTS.join(', ')}
`;

function parseArgs(argv) {
  const opts = { cmd: 'install', claude: false, codex: false, project: false, force: false };
  for (const a of argv) {
    if (a === 'install' || a === 'uninstall') opts.cmd = a;
    else if (a === '--claude') opts.claude = true;
    else if (a === '--codex') opts.codex = true;
    else if (a === '--project') opts.project = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '-h' || a === '--help') opts.cmd = 'help';
    else if (a === '-v' || a === '--version') opts.cmd = 'version';
    else throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
  }
  return opts;
}

function claudeDir(project) {
  return project ? path.join(process.cwd(), '.claude') : path.join(os.homedir(), '.claude');
}

function codexDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function pickTargets(opts) {
  if (opts.claude || opts.codex) return opts;
  const hasClaude = fs.existsSync(claudeDir(false));
  const hasCodex = fs.existsSync(codexDir());
  return { ...opts, claude: hasClaude || !hasCodex, codex: hasCodex || !hasClaude };
}

// The plugin build refers to agents as "development-pipeline:<name>". A plain ~/.claude
// install registers them without the prefix, so strip it and the note that explains it.
function toStandaloneClaudeSkill(text) {
  return text
    .replace(/\n> \*\*Agent names:\*\*[\s\S]*?\n\n/, '\n\n')
    .replace(/development-pipeline:/g, '');
}

function writeFile(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function copyDir(src, dest, transform) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, transform);
    else if (transform && entry.name === 'SKILL.md') writeFile(d, transform(fs.readFileSync(s, 'utf8')));
    else fs.copyFileSync(s, d);
  }
}

// Returns true when the item may be written; records a skip otherwise.
function claim(dest, force, report) {
  if (fs.existsSync(dest) && !force) {
    report.skipped.push(dest);
    return false;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  report.written.push(dest);
  return true;
}

function installClaude(opts, report) {
  const root = claudeDir(opts.project);
  for (const s of SKILLS) {
    const dest = path.join(root, 'skills', s);
    if (claim(dest, opts.force, report)) copyDir(path.join(PLUGIN_DIR, 'skills', s), dest, toStandaloneClaudeSkill);
  }
  for (const a of AGENTS) {
    const dest = path.join(root, 'agents', `${a}.md`);
    if (claim(dest, opts.force, report)) writeFile(dest, fs.readFileSync(path.join(PLUGIN_DIR, 'agents', `${a}.md`)));
  }
  return root;
}

function installCodex(opts, report) {
  const root = codexDir();
  const agentsDir = path.join(root, 'agents');
  const agentsPath = agentsDir.split(path.sep).join('/');
  for (const s of SKILLS) {
    const dest = path.join(root, 'skills', s);
    if (claim(dest, opts.force, report)) {
      copyDir(path.join(CODEX_SRC, 'skills', s), dest, (t) => t.split('{{CODEX_AGENTS_DIR}}').join(agentsPath));
    }
  }
  for (const a of AGENTS) {
    const dest = path.join(agentsDir, `${a}.toml`);
    if (claim(dest, opts.force, report)) writeFile(dest, fs.readFileSync(path.join(CODEX_SRC, 'agents', `${a}.toml`)));
  }
  return root;
}

function uninstall(root, agentExt, report) {
  const targets = [
    ...SKILLS.map((s) => path.join(root, 'skills', s)),
    ...AGENTS.map((a) => path.join(root, 'agents', `${a}${agentExt}`)),
  ];
  for (const t of targets) {
    if (fs.existsSync(t)) {
      fs.rmSync(t, { recursive: true, force: true });
      report.written.push(t);
    }
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (opts.cmd === 'help') return console.log(HELP);
  if (opts.cmd === 'version') return console.log(VERSION);
  if (opts.project && opts.codex) {
    console.error('--project applies to Claude Code only; run --codex separately without it.');
    process.exit(1);
  }

  opts = pickTargets(opts);
  const report = { written: [], skipped: [] };
  const done = [];

  if (opts.cmd === 'uninstall') {
    if (opts.claude) { uninstall(claudeDir(opts.project), '.md', report); done.push('Claude Code'); }
    if (opts.codex) { uninstall(codexDir(), '.toml', report); done.push('Codex'); }
    console.log(`Removed ${report.written.length} item(s) from ${done.join(' and ')}.`);
    report.written.forEach((p) => console.log(`  - ${p}`));
    return;
  }

  if (opts.claude) done.push(`Claude Code -> ${installClaude(opts, report)}`);
  if (opts.codex) done.push(`Codex -> ${installCodex(opts, report)}`);

  console.log(`development-pipeline v${VERSION}`);
  done.forEach((d) => console.log(`  ${d}`));
  if (report.skipped.length) {
    console.log(`\nSkipped ${report.skipped.length} item(s) that already exist (re-run with --force to overwrite):`);
    report.skipped.forEach((p) => console.log(`  - ${p}`));
  }
  console.log('\nRestart Claude Code / Codex, then run /build-project, /review-fix or /review-implement');
  console.log('(in Codex: $build-project, $review-fix, $review-implement).');
}

main();
