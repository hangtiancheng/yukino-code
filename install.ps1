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
default_provider: 0
providers:
  - name: anthropic
    protocol: anthropic
    base_url: https://api.deepseek.com/anthropic
    model: "deepseek-flash"
    api_key: "<your-api-key>"
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000
  - name: openai-compat
    protocol: openai-compat
    base_url: https://api.deepseek.com
    model: "deepseek-flash"
    api_key: "<your-api-key>"
    thinking: high
    context_window: 1000000
    max_output_tokens: 128000
mcp_servers:
  - name: "yukino-mcp-stdio"
    command: "pnpm"
    args: ["--filter", "@yukino.js/mcp", "dev"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
  - name: "yukino-mcp-http"
    url: "http://127.0.0.1:3300/mcp"
    transport: "http"
    headers: { Authorization: "Bearer <your-token>" }
  - name: "yukino-mcp-sse"
    url: "http://127.0.0.1:3300/sse"
    transport: "sse"
hooks:
  - id: lint-on-edit
    # enum: session_start | session_end | turn_start | turn_end | pre_send | post_receive | pre_tool_use | post_tool_use | shutdown
    event: post_tool_use
    condition: 'tool == "EditFile"'
    action:
      # enum: command | prompt | http | agent
      type: command
      command: pnpm exec eslint --fix "$YUKINO_FILE_PATH"
    reject: false # Only effective on pre_tool_use
    once: false
    async: false
    on_error: ignore
sandbox:
  enabled: false
  auto_allow: false
  network_enabled: true
enable_coordinator_mode: false
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
