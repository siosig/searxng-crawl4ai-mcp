#Requires -Version 7.0
<#
.SYNOPSIS
    Register this checkout with Claude Code as a plugin.

.DESCRIPTION
    The MCP server runs elsewhere (Streamable HTTP with a bearer token), so nothing
    is built here: the plugin only tells Claude Code where the endpoint is and which
    token to present.

    The endpoint and token come from the repository-root .env, which is gitignored.
    That file already holds MCP_AUTH_TOKEN for the deployment, so the token is not
    maintained in two places, and the hostname never enters a tracked file.

    .env keys (see .env.example):
      MCP_PUBLIC_ENDPOINT     the URL clients connect to, including the path
      MCP_PUBLIC_AUTH_TOKEN   the token that endpoint enforces; falls back to
                              MCP_AUTH_TOKEN when unset

    The two token keys exist because .env describes two things at once: the
    stack this checkout runs locally, and the deployment the client should talk
    to. Those are the same while pointing at the local stack, and different as
    soon as the endpoint is a deployed host.

.PARAMETER Endpoint
    Overrides MCP_PUBLIC_ENDPOINT from .env.

.PARAMETER Token
    Overrides MCP_PUBLIC_AUTH_TOKEN (or MCP_AUTH_TOKEN) from .env.

.PARAMETER Scope
    user, project or local. Defaults to user.

.PARAMETER SkipCheck
    Install without first checking that the endpoint answers.

.EXAMPLE
    ./install_claude_plugin.ps1

.EXAMPLE
    ./install_claude_plugin.ps1 -Endpoint 'https://mcp.example.com/mcp-searxng-crawl4ai'

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\install_claude_plugin.ps1

.NOTES
    Needs PowerShell 7 (pwsh). Windows PowerShell 5.1 lacks -SkipHttpErrorCheck
    and writes UTF-8 with a BOM, which Claude Code's settings.json must not have;
    the #Requires line above turns both into one clear error instead.
#>
[CmdletBinding()]
param(
    [string]$Endpoint,
    [string]$Token,
    [ValidateSet('user', 'project', 'local')]
    [string]$Scope = 'user',
    [string]$EnvFile,
    [string]$MarketplaceSource,
    [switch]$SkipCheck
)

$ErrorActionPreference = 'Stop'

$MarketplaceName = 'searxng-crawl4ai-mcp'
$PluginName      = 'searxng-crawl4ai-mcp'
$PluginRef       = "$PluginName@$MarketplaceName"
$McpServerName   = 'searxng-crawl4ai'

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $EnvFile)           { $EnvFile = Join-Path $RepoDir '.env' }
if (-not $MarketplaceSource) { $MarketplaceSource = $RepoDir }

# The eight tools this server exposes. Kept in sync with src/server.ts.
$ToolPrefix = "mcp__plugin_${MarketplaceName}_${McpServerName}__"
$McpTools = @(
    'web_search', 'web_scrape', 'web_search_and_scrape', 'web_batch_scrape',
    'web_crawl', 'web_map', 'web_extract', 'web_job_status'
) | ForEach-Object { "$ToolPrefix$_" }

function Write-Ok   { param($m) Write-Host "✓ $m" -ForegroundColor Green }
function Write-Step { param($m) Write-Host "→ $m" -ForegroundColor Cyan }

# Read one KEY=VALUE from the .env without executing it. Running a secrets file
# as code is the last thing to do with it.
function Get-EnvValue {
    param([string]$Key)
    if (-not (Test-Path $EnvFile)) { return $null }
    $line = Get-Content $EnvFile |
        Where-Object { $_ -match "^\s*$([regex]::Escape($Key))=" } |
        Select-Object -Last 1
    if (-not $line) { return $null }
    ($line -replace "^\s*$([regex]::Escape($Key))=", '').Trim().Trim('"').Trim("'")
}

# --- 1. Prerequisites --------------------------------------------------------
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Error "'claude' not found. Install Claude Code: https://claude.ai/code"
    exit 1
}
Write-Ok "claude: $($claude.Source)"

# --- 2. Configuration --------------------------------------------------------
if (-not $Endpoint) { $Endpoint = Get-EnvValue 'MCP_PUBLIC_ENDPOINT' }
if (-not $Token)    { $Token    = Get-EnvValue 'MCP_PUBLIC_AUTH_TOKEN' }
if (-not $Token)    { $Token    = Get-EnvValue 'MCP_AUTH_TOKEN' }

if (-not $Endpoint) {
    Write-Error "No endpoint. Set MCP_PUBLIC_ENDPOINT in $EnvFile, or pass -Endpoint.`n       Example: https://mcp.example.com/mcp-searxng-crawl4ai"
    exit 1
}
if (-not $Token) {
    Write-Error "No token. Set MCP_PUBLIC_AUTH_TOKEN (or MCP_AUTH_TOKEN) in $EnvFile, or pass -Token."
    exit 1
}
$manifest = Join-Path $RepoDir '.claude-plugin/marketplace.json'
if (-not (Test-Path $manifest)) {
    Write-Error "marketplace.json not found at $manifest"
    exit 1
}

if (Test-Path $EnvFile) { Write-Ok "config from: $EnvFile" } else { Write-Ok "config from: parameters (no $EnvFile)" }
Write-Ok "endpoint: $Endpoint"
Write-Ok "token: set"
Write-Ok "marketplace source: $MarketplaceSource"

# --- 3. Endpoint reachability ------------------------------------------------
# Checking now turns "the tools are missing after restart" into an error with a
# cause attached. The 2026-07-28 revision restates the method in headers and
# carries a per-request envelope, so a bare initialize is not a valid probe.
if (-not $SkipCheck) {
    Write-Step 'checking the endpoint answers an authenticated tools/list'
    $body = @{
        jsonrpc = '2.0'; id = 1; method = 'tools/list'
        params  = @{ _meta = @{
            'io.modelcontextprotocol/protocolVersion'   = '2026-07-28'
            'io.modelcontextprotocol/clientInfo'        = @{ name = 'install_claude_plugin.ps1'; version = '1.0' }
            'io.modelcontextprotocol/clientCapabilities' = @{}
        } }
    } | ConvertTo-Json -Depth 8 -Compress

    try {
        $res = Invoke-WebRequest -Uri $Endpoint -Method Post -TimeoutSec 20 -SkipHttpErrorCheck -Headers @{
            'Content-Type'         = 'application/json'
            'Accept'               = 'application/json, text/event-stream'
            'MCP-Protocol-Version' = '2026-07-28'
            'Mcp-Method'           = 'tools/list'
            'Authorization'        = "Bearer $Token"
        } -Body $body
    } catch {
        Write-Error "Could not reach $Endpoint : $($_.Exception.Message)`n       Pass -SkipCheck to install anyway."
        exit 1
    }

    switch ($res.StatusCode) {
        200 {
            $count = ([regex]::Matches($res.Content, '"name":"web_[a-z_]*"')).Count
            Write-Ok "endpoint: reachable, tools advertised: $count"
        }
        401 { Write-Error 'The endpoint rejected the token (HTTP 401).'; exit 1 }
        default {
            Write-Error "The endpoint answered HTTP $($res.StatusCode) (expected 200).`n       $($res.Content.Substring(0, [Math]::Min(300, $res.Content.Length)))`n       Pass -SkipCheck to install anyway."
            exit 1
        }
    }
} else {
    Write-Ok 'endpoint check: skipped'
}

# --- 4. Marketplace (idempotent) --------------------------------------------
# A stale registration pointing at an old path makes `update` fail and leaves an
# empty marketplace, which then fails the install with a much less obvious
# message. Re-register rather than ignoring the failure.
$existing = (& claude plugin marketplace list 2>&1 | Out-String)
if ($existing -match [regex]::Escape($MarketplaceName)) {
    Write-Step "refreshing marketplace '$MarketplaceName'"
    & claude plugin marketplace update $MarketplaceName 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  update failed - re-registering from $MarketplaceSource"
        & claude plugin marketplace remove $MarketplaceName 2>&1 | Out-Null
        & claude plugin marketplace add $MarketplaceSource | Out-Host
    }
} else {
    Write-Step "registering marketplace '$MarketplaceName': $MarketplaceSource"
    & claude plugin marketplace add $MarketplaceSource | Out-Host
}
Write-Ok "marketplace '$MarketplaceName': ready"

# --- 5. Reinstall (idempotent) ----------------------------------------------
& claude plugin details $PluginRef 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Step "uninstalling the existing '$PluginRef' (scope=$Scope)"
    & claude plugin uninstall $PluginRef --scope $Scope 2>&1 | Out-Host
}

Write-Step "installing '$PluginRef' (scope=$Scope)"
& claude plugin install $PluginRef --config "endpoint=$Endpoint" --config "token=$Token" --scope $Scope | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Error "install failed"; exit 1 }
Write-Ok "'$PluginRef': installed"

Write-Step 'verifying'
& claude plugin details $PluginRef 2>&1 | Out-Host

# --- 6. Allow the tools without a prompt ------------------------------------
$SettingsFile = Join-Path $HOME '.claude/settings.json'
if (-not (Test-Path $SettingsFile)) {
    Write-Warning "$SettingsFile not found - skipping permission registration"
} else {
    Write-Step "allowing the $($McpTools.Count) tools in $SettingsFile"
    $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json

    if (-not $settings.PSObject.Properties['permissions']) {
        $settings | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not $settings.permissions.PSObject.Properties['allow']) {
        $settings.permissions | Add-Member -NotePropertyName allow -NotePropertyValue @()
    }

    # Drop any entry from an older install of this plugin before adding the
    # current set, so renamed tools do not linger as dead permissions.
    $kept = @($settings.permissions.allow | Where-Object { $_ -notlike "$ToolPrefix*" })
    $settings.permissions.allow = @($kept + $McpTools | Sort-Object -Unique)

    $settings | ConvertTo-Json -Depth 32 | Set-Content $SettingsFile -Encoding utf8
    Write-Ok 'permissions registered'
}

Write-Host @"

------------------------------------------------------------------
Done.

  endpoint : $Endpoint
  scope    : $Scope
  tools    : $($McpTools.Count) (web_search, web_scrape, web_crawl, ...)

Restart Claude Code to pick the tools up.
------------------------------------------------------------------
"@
