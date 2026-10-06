# Installs the development-pipeline skills and agents into Codex.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1   (uses $env:CODEX_HOME, default ~/.codex)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$agentsDir = Join-Path $codexDir 'agents'
$skillsDir = Join-Path $codexDir 'skills'
New-Item -ItemType Directory -Force $agentsDir, $skillsDir | Out-Null
Copy-Item (Join-Path (Join-Path $src 'agents') '*.toml') $agentsDir -Force
$agentsPath = $agentsDir.Replace([char]92, [char]47)
foreach ($s in 'build-project', 'review-fix', 'review-implement') {
  $from = Join-Path (Join-Path $src 'skills') $s
  $dest = Join-Path $skillsDir $s
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse $from $dest
  $text = [IO.File]::ReadAllText((Join-Path $from 'SKILL.md')).Replace('{{CODEX_AGENTS_DIR}}', $agentsPath)
  [IO.File]::WriteAllText((Join-Path $dest 'SKILL.md'), $text, (New-Object Text.UTF8Encoding $false))
}
Write-Host "Installed to $codexDir (skills: build-project, review-fix, review-implement). Restart Codex."
