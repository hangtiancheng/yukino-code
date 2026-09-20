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
# permission_mode - optional, string, default: "default"
# One of: "default" | "acceptEdits" | "plan" | "bypassPermissions"
permission_mode: bypassPermissions

# providers - REQUIRED: at least one provider must be configured (after merging all layers).
providers:
  - name: anthropic # REQUIRED, string - unique provider name
    protocol: anthropic # REQUIRED, enum: "anthropic" | "openai" | "openai-compat"
    base_url: https://api.deepseek.com/anthropic # REQUIRED, string - API endpoint
    model: "deepseek-flash" # REQUIRED, string - model identifier
    api_key: "<your-api-key>" # optional, string, default: falls back to env var
      #   (ANTHROPIC_API_KEY for protocol "anthropic", OPENAI_API_KEY for "openai"/"openai-compat")
    thinking: true # optional, boolean, default: false - enable extended thinking
    context_window: 1000000 # optional, number, default: built-in lookup by model name
      #   (claude -> 200000, gpt-4.1/1m -> 1000000, else 128000)
    # max_output_tokens: 64000               # optional, number, default: 8192 (64000 when thinking: true)

  - name: openai-compat
    protocol: openai-compat
    base_url: https://api.deepseek.com
    model: "deepseek-flash"
    api_key: "<your-api-key>"
    thinking: true
    context_window: 1000000
    # max_output_tokens: 64000

# mcp_servers - optional, array, default: [] (no servers).
# Each server needs either `command` (stdio transport) or `url` (http/sse transport).
mcp_servers: []
  # - name: filesystem                       # REQUIRED, string - unique server name
  #   command: npx                           # optional, string - executable; presence selects stdio transport
  #   args: ["-y", "@modelcontextprotocol/server-filesystem", "."]  # optional, string array, default: []
  #   env: { API_KEY: "your-api-key" }       # optional, map<string, string>, default: {} - extra env vars
  #
  # - name: remote-server
  #   url: https://example.com/mcp           # optional, string - presence selects http/sse transport
  #   transport: sse                         # optional, string - "sse" for SSE; any other value/omitted
  #                                          #   uses streamable HTTP (only relevant with `url`)
  #   headers: { Authorization: "Bearer x" } # optional, map<string, string>, default: {} - HTTP headers

# hooks - optional, array, default: []. Appended across config layers (never replaced).
hooks: []
  # - id: lint-on-edit                       # optional, string - hook identifier
  #   event: post_tool_use                   # REQUIRED, enum: session_start | session_end | turn_start |
  #                                          #   turn_end | pre_send | post_receive | pre_tool_use |
  #                                          #   post_tool_use | shutdown
  #   condition: 'tool == "EditFile"'        # optional, string - expression filtering when the hook fires
  #   action:                                # REQUIRED, object
  #     type: command                        # REQUIRED, enum: command | prompt | http | agent
  #     command: npx eslint --fix "$YUKINO_FILE_PATH"  # required for type "command" (also accepted by "agent")
  #     # prompt: "..."                      # required for type "prompt" and "agent"
  #     # url: https://example.com/webhook   # required for type "http"
  #     # method: POST                       # optional, string - HTTP method for type "http"
  #   reject: false                          # optional, boolean, default: false - block the tool call
  #                                          #   (only effective on pre_tool_use)
  #   once: false                            # optional, boolean, default: false - fire at most once per session
  #   async: false                           # optional, boolean, default: false - run without awaiting result
  #   on_error: ignore                       # optional, string, default: "ignore" - error handling policy

# sandbox - optional, object, default: sandbox disabled.
# sandbox:
#   enabled: false                           # optional, boolean, default: false - wrap Bash commands in a sandbox
#   auto_allow: false                        # optional, boolean, default: false - auto-approve sandboxed commands
#   network_enabled: true                    # optional, boolean, default: true - allow network inside the sandbox

# enable_coordinator_mode - optional, boolean, default: false - enable multi-agent coordinator mode.
# enable_coordinator_mode: false
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
