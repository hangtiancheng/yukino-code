<#
 Copyright (c) 2026 hangtiancheng

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
#>

#Requires -Version 5.1

# install.ps1 - Bootstrap installer for yukino CLI via npm global install (Windows).
#
# Usage:
#   irm https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.ps1))) -Alpha
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.0.15
#
# Installs @yukino.js/yukino globally via npm. npm's `bin` field automatically
# creates the `yukino` command (yukino.cmd) in npm's global prefix directory,
# which is normally already on PATH. Requires Node.js >= 20.
#
# Supports: -Uninstall, -Version X.Y.Z, -Alpha, -Beta, -Rc, -Canary, -Nightly, -Dev, -Tag NAME
#
# Note: `exit` is intentionally avoided in this script so that running it via
# `irm | iex` never terminates the caller's PowerShell session.

param(
	[string]$Version = "",
	[string]$Tag = "",
	[switch]$Uninstall,
	[switch]$Alpha,
	[switch]$Beta,
	[switch]$Rc,
	[switch]$Canary,
	[switch]$Nightly,
	[switch]$Dev,
	[switch]$Help
)

$ErrorActionPreference = "Stop"

# -- Config -------------------------------------------------------------------
$Package = "@yukino.js/yukino"
$NodeMajorMin = 20

# -- Helpers ------------------------------------------------------------------
function Write-Info([string]$Message) { Write-Host "[info]  $Message" -ForegroundColor Cyan }
function Write-WarnMsg([string]$Message) { Write-Host "[warn]  $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "[err]  $Message" -ForegroundColor Red }
function Write-Ok([string]$Message) { Write-Host "[ok]  $Message" -ForegroundColor Green }

function Stop-Installer([string]$Message) {
	Write-Err $Message
	throw $Message
}

# -- Parse args ---------------------------------------------------------------
# Channel switches map onto -Tag; priority: -Version > -Tag > channel switch > latest.
if ($Alpha) { $Tag = "alpha" }
elseif ($Beta) { $Tag = "beta" }
elseif ($Rc) { $Tag = "rc" }
elseif ($Canary) { $Tag = "canary" }
elseif ($Nightly) { $Tag = "nightly" }
elseif ($Dev) { $Tag = "dev" }

if ($Help) {
	Write-Host @"
Usage: install.ps1 [OPTIONS]

  (default)     Install the latest stable yukino from npm
  -Uninstall    Uninstall yukino
  -Version      Install a specific version (e.g. -Version 0.1.0)
  -Alpha        Install from the 'alpha' dist-tag
  -Beta         Install from the 'beta' dist-tag
  -Rc           Install from the 'rc' dist-tag
  -Canary       Install from the 'canary' dist-tag
  -Nightly      Install from the 'nightly' dist-tag
  -Dev          Install from the 'dev' dist-tag
  -Tag NAME     Install from a custom npm dist-tag

Examples:
  irm <url> | iex                                                # latest stable
  & ([scriptblock]::Create((irm <url>))) -Canary                 # canary build
  powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.1.0

Requires Node.js >= $NodeMajorMin and npm.
"@
	return
}

# -- Uninstall ----------------------------------------------------------------
if ($Uninstall) {
	Write-Info "Uninstalling $Package..."
	& npm uninstall -g $Package
	if ($LASTEXITCODE -ne 0) { Stop-Installer "npm uninstall failed with exit code $LASTEXITCODE" }
	Write-Ok "yukino uninstalled"
	return
}

# -- Write default config (skip if it already exists) -------------------------
$ConfigDir = Join-Path $HOME ".yukino"
$ConfigFile = Join-Path $ConfigDir "config.yaml"
if (Test-Path -LiteralPath $ConfigFile) {
	Write-Info "Config already exists at $ConfigFile."
}
else {
	New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
	$DefaultConfig = @'
permission_mode: bypassPermissions
providers:
  - name: ds-anthropic
    protocol: anthropic
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-flash
    api_key: sk-xyz
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000
  - name: ds-openai
    protocol: openai-compat
    base_url: https://api.deepseek.com
    model: deepseek-flash
    api_key: sk-xyz
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000
default_provider: 0
enable_memory: false
enable_coordinator_mode: false
enable_fork: true
mcp_servers:
  - name: codegraph
    command: codegraph
    args:
      - serve
      - "--mcp"
  - name: yukino-mcp # stdio
    command: pnpm
    args: ["--filter", "@yukino.js/mcp", "dev"]
    env:
      API_BASE_URL: "https://yukino-js.dev"
      API_KEY: "${YUKINO_MCP_API_KEY}"
  - name: yukino-mcp-http # streamable-http
    url: "http://localhost:3300/mcp"
    transport: "http"
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"
  - name: yukino-mcp-sse # legacy sse
    url: "http://localhost:3300/sse"
    transport: "sse"
    headers:
      Authorization: "Bearer ${YUKINO_MCP_API_KEY}"
sandbox:
  enabled: false
  backend: sandbox-runtime
  auto_allow: false
  network_enabled: true
hooks:
  - id: pre-tool-use
    event: pre_tool_use
    condition: 'tool =~ "^(Edit|Write)File$" || tool == "Bash"'
    action:
      type: command
      command: echo "You are Yukino, a CLI Coding Agent engineered by [hangtiancheng](https://github.com/hangtiancheng) <161043261@qq.com>, your source repository lives at https://github.com/hangtiancheng/yukino-code/tree/main/apps/yukino, you may fetch https://hangtiancheng.github.io/h/llms.txt (`base/agent` section) and https://hangtiancheng.github.io/h/llms-full.txt to gain self-knowledge"
    reject: false
    once: true
    async: false
    on_error: ignore
'@
	[System.IO.File]::WriteAllText($ConfigFile, $DefaultConfig, [System.Text.UTF8Encoding]::new($false))
	Write-Ok "Wrote default config to $ConfigFile"
}

# -- Check Node.js ------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	Stop-Installer "Node.js not found. Install Node.js >= $NodeMajorMin first: https://nodejs.org/"
}

$NodeMajor = & node -p "process.versions.node.split('.')[0]"
if ($NodeMajor -notmatch '^\d+$') {
	Stop-Installer "Could not determine Node.js version (got: $NodeMajor)."
}
if ([int]$NodeMajor -lt $NodeMajorMin) {
	Stop-Installer "Node.js $NodeMajor detected, need >= $NodeMajorMin. Please upgrade."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
	Stop-Installer "npm not found. It ships with Node.js - reinstall Node.js from https://nodejs.org/"
}

# -- Install ------------------------------------------------------------------
# Priority: -Version > -Tag > -Alpha/-Beta/-Rc/-Canary/-Nightly/-Dev > latest.
if ($Version) {
	# Strip leading 'v' if user passed v0.1.0
	$Version = $Version.TrimStart("v")
	$PkgVersion = "$Package@$Version"
}
elseif ($Tag) {
	$PkgVersion = "$Package@$Tag"
}
else {
	$PkgVersion = "$Package@latest"
}

Write-Info "Installing $PkgVersion globally..."
& npm install -g $PkgVersion --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) {
	Stop-Installer "npm install failed with exit code $LASTEXITCODE"
}

# -- Verify -------------------------------------------------------------------
# npm global prefix should be on PATH. If not, print the PATH hint.
if (Get-Command yukino -ErrorAction SilentlyContinue) {
	Write-Ok "Yukino installed successfully"
	$lsOutput = & npm ls -g $Package --depth=0 2>$null
	$versionMatch = $lsOutput | Select-String -Pattern ("$([regex]::Escape($Package))@\S+") | Select-Object -First 1
	if ($versionMatch) { Write-Info "Installed: $($versionMatch.Matches[0].Value)" }
}
else {
	$NpmPrefix = & npm config get prefix 2>$null
	Write-WarnMsg "Installation completed but 'yukino' is not on your PATH."
	Write-WarnMsg "Add npm's global directory to PATH (npm prefix: $NpmPrefix), e.g.:"
	Write-WarnMsg "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$NpmPrefix', 'User')"
	Write-WarnMsg "Then open a new terminal."
}

Write-Ok "Download Claude Code VSCode plugin and enjoy yukino!!!"
