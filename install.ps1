#Requires -Version 5.1


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

$Package = "@yukino.js/yukino"
$NodeRequirement = "22.19+ (23.x requires 23.5+)"

function Write-Info([string]$Message) { Write-Host "[info]  $Message" -ForegroundColor Cyan }
function Write-WarnMsg([string]$Message) { Write-Host "[warn]  $Message" -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host "[err]  $Message" -ForegroundColor Red }
function Write-Ok([string]$Message) { Write-Host "[ok]  $Message" -ForegroundColor Green }

function Stop-Installer([string]$Message) {
	Write-Err $Message
	throw $Message
}

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

Requires Node.js $NodeRequirement and npm.
"@
	return
}

if ($Uninstall) {
	Write-Info "Uninstalling $Package..."
	& npm uninstall -g $Package
	if ($LASTEXITCODE -ne 0) { Stop-Installer "npm uninstall failed with exit code $LASTEXITCODE" }
	Write-Ok "yukino uninstalled"
	return
}

$ConfigDir = Join-Path $HOME ".yukino"
$ConfigFile = Join-Path $ConfigDir "config.yaml"
if (Test-Path -LiteralPath $ConfigFile) {
	Write-Info "Config already exists at $ConfigFile."
}
else {
	New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
	$DefaultConfig = @'
permission_mode: default
providers: []
default_provider: 0
enable_memory: false
enable_coordinator_mode: false
code_mode:
  mode: off
  inline_budget: 12000
mcp_servers: []
hooks: []
sandbox:
  enabled: false
  auto_allow: false
  network_enabled: true
'@
	[System.IO.File]::WriteAllText($ConfigFile, $DefaultConfig, [System.Text.UTF8Encoding]::new($false))
	Write-Ok "Wrote default config to $ConfigFile"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	Stop-Installer "Node.js not found. Install Node.js $NodeRequirement first: https://nodejs.org/"
}

$NodeVersion = & node -p "process.versions.node"
$SupportsRuntime = & node -p '(() => { const [major,minor]=process.versions.node.split(".").map(Number); return (major > 22 || (major === 22 && minor >= 19)) && typeof require("node:module").registerHooks === "function"; })()'
if ($SupportsRuntime -ne "true") {
	Stop-Installer "Node.js $NodeVersion detected, need $NodeRequirement. Please upgrade."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
	Stop-Installer "npm not found. It ships with Node.js - reinstall Node.js from https://nodejs.org/"
}

if ($Version) {
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
