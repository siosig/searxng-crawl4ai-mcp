#!/usr/bin/env bash
#
# install_claude_plugin.sh - register this checkout with Claude Code as a plugin.
#
# The MCP server runs elsewhere (Streamable HTTP with a bearer token), so nothing
# is built here: the plugin only tells Claude Code where the endpoint is and which
# token to present.
#
# The marketplace is registered by path rather than by git URL. `claude plugin
# marketplace add` accepts owner/repo, an https:// URL, or ./path, and rejects SSH
# git URLs - and a local path also means the plugin follows this working copy
# without a push/pull round trip.
#
# The endpoint and token come from the repository-root .env, which is gitignored.
# That file already holds MCP_AUTH_TOKEN for the deployment, so the token is not
# maintained in two places, and the hostname never enters a tracked file.
#
# .env keys (see .env.example):
#   MCP_PUBLIC_ENDPOINT     the URL clients connect to, including the path
#   MCP_PUBLIC_AUTH_TOKEN   the token that endpoint enforces; falls back to
#                           MCP_AUTH_TOKEN when unset
#
# The two token keys exist because .env describes two things at once: the stack
# this checkout runs locally (MCP_AUTH_TOKEN) and the deployment the client
# should talk to. Those are the same while pointing at the local stack, and
# different as soon as the endpoint is a deployed host - at which point sending
# the local token would just produce a 401.
#
# Environment variables override .env when set:
#   SEARXNG_CRAWL4AI_ENDPOINT           endpoint URL
#   SEARXNG_CRAWL4AI_ACCESS_TOKEN       bearer token
#   SEARXNG_CRAWL4AI_ENV_FILE           path to the .env (default: alongside this script)
#   SEARXNG_CRAWL4AI_MARKETPLACE_SOURCE marketplace source (default: this checkout)
#   PLUGIN_SCOPE                        user | project | local (default: user)
#   SKIP_CHECK=1                        skip the endpoint reachability check
#
# Usage:
#   ./install_claude_plugin.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || pwd)"
ENV_FILE="${SEARXNG_CRAWL4AI_ENV_FILE:-${REPO_DIR}/.env}"

# Read one KEY=VALUE from the .env without executing it. Sourcing the file would
# run whatever it contains, and a secrets file is the last thing to hand to the
# shell as code.
_env_get() {
  [[ -f "${ENV_FILE}" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "${ENV_FILE}" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

ENDPOINT="${SEARXNG_CRAWL4AI_ENDPOINT:-$(_env_get MCP_PUBLIC_ENDPOINT)}"
TOKEN="${SEARXNG_CRAWL4AI_ACCESS_TOKEN:-$(_env_get MCP_PUBLIC_AUTH_TOKEN)}"
[[ -z "${TOKEN}" ]] && TOKEN="$(_env_get MCP_AUTH_TOKEN)"
SCOPE="${PLUGIN_SCOPE:-user}"

MARKETPLACE_NAME="searxng-crawl4ai-mcp"
PLUGIN_NAME="searxng-crawl4ai-mcp"
PLUGIN_REF="${PLUGIN_NAME}@${MARKETPLACE_NAME}"
MCP_SERVER_NAME="searxng-crawl4ai"

MARKETPLACE_SOURCE="${SEARXNG_CRAWL4AI_MARKETPLACE_SOURCE:-${REPO_DIR}}"

# The eight tools this server exposes. Kept in sync with src/server.ts.
TOOL_PREFIX="mcp__plugin_${MARKETPLACE_NAME}_${MCP_SERVER_NAME}__"
MCP_TOOLS=(
  "${TOOL_PREFIX}web_search"
  "${TOOL_PREFIX}web_scrape"
  "${TOOL_PREFIX}web_search_and_scrape"
  "${TOOL_PREFIX}web_batch_scrape"
  "${TOOL_PREFIX}web_crawl"
  "${TOOL_PREFIX}web_map"
  "${TOOL_PREFIX}web_extract"
  "${TOOL_PREFIX}web_job_status"
)

_require() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found. Install it and try again." >&2
    [[ -n "${2:-}" ]] && echo "       $2" >&2
    exit 1
  fi
  echo "✓ $1: $(command -v "$1")"
}

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
_require claude "https://claude.ai/code"

# ── 2. Configuration ─────────────────────────────────────────────────────────
if [[ -z "${ENDPOINT}" ]]; then
  echo "ERROR: no endpoint. Set MCP_PUBLIC_ENDPOINT in ${ENV_FILE}," >&2
  echo "       or pass SEARXNG_CRAWL4AI_ENDPOINT in the environment." >&2
  echo "       Example: MCP_PUBLIC_ENDPOINT=https://mcp.example.com/mcp-searxng-crawl4ai" >&2
  exit 1
fi
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: no token. Set MCP_PUBLIC_AUTH_TOKEN (or MCP_AUTH_TOKEN) in ${ENV_FILE}," >&2
  echo "       or pass SEARXNG_CRAWL4AI_ACCESS_TOKEN in the environment." >&2
  exit 1
fi
[[ -f "${ENV_FILE}" ]] && echo "✓ config from: ${ENV_FILE}" || echo "✓ config from: environment (no ${ENV_FILE})"
if [[ ! -f "${REPO_DIR}/.claude-plugin/marketplace.json" ]]; then
  echo "ERROR: marketplace.json not found at ${REPO_DIR}/.claude-plugin/" >&2
  exit 1
fi
echo "✓ endpoint: ${ENDPOINT}"
echo "✓ token: set"
echo "✓ marketplace source: ${MARKETPLACE_SOURCE}"

# ── 3. Endpoint reachability ─────────────────────────────────────────────────
# Checking now turns "the tools are missing after restart" into an error with a
# cause attached. The 2026-07-28 revision restates the method in headers and
# carries a per-request envelope, so a bare initialize is not a valid probe.
if [[ "${SKIP_CHECK:-0}" != "1" ]] && command -v curl &>/dev/null; then
  echo "→ checking the endpoint answers an authenticated tools/list"
  code="$(curl -sS -o /tmp/.mcp_probe.$$ -w '%{http_code}' --max-time 20 \
    -X POST "${ENDPOINT}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    -H 'Mcp-Method: tools/list' \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"install_claude_plugin.sh","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' \
    2>/dev/null || echo "000")"
  body="$(cat /tmp/.mcp_probe.$$ 2>/dev/null || true)"; rm -f /tmp/.mcp_probe.$$
  case "${code}" in
    200) echo "✓ endpoint: reachable, tools advertised: $(grep -o '"name":"web_[a-z_]*"' <<<"${body}" | wc -l)" ;;
    401) echo "ERROR: the endpoint rejected the token (HTTP 401)." >&2; exit 1 ;;
    000) echo "ERROR: could not reach ${ENDPOINT}." >&2
         echo "       Set SKIP_CHECK=1 to install anyway." >&2; exit 1 ;;
    *)   echo "ERROR: the endpoint answered HTTP ${code} (expected 200)." >&2
         echo "       ${body:0:300}" >&2
         echo "       Set SKIP_CHECK=1 to install anyway." >&2; exit 1 ;;
  esac
else
  echo "✓ endpoint check: skipped"
fi

# ── 4. Marketplace (idempotent) ──────────────────────────────────────────────
# A stale registration pointing at an old path makes `update` fail with ENOENT
# and leaves an empty marketplace, which then fails the install with a much less
# obvious message. Re-register rather than ignoring the failure.
if claude plugin marketplace list 2>/dev/null | grep -q "${MARKETPLACE_NAME}"; then
  echo "→ refreshing marketplace '${MARKETPLACE_NAME}'"
  if ! claude plugin marketplace update "${MARKETPLACE_NAME}"; then
    echo "  update failed - re-registering from ${MARKETPLACE_SOURCE}"
    claude plugin marketplace remove "${MARKETPLACE_NAME}" || true
    claude plugin marketplace add "${MARKETPLACE_SOURCE}"
  fi
else
  echo "→ registering marketplace '${MARKETPLACE_NAME}': ${MARKETPLACE_SOURCE}"
  claude plugin marketplace add "${MARKETPLACE_SOURCE}"
fi
echo "✓ marketplace '${MARKETPLACE_NAME}': ready"

# ── 5. Reinstall (idempotent) ────────────────────────────────────────────────
if claude plugin details "${PLUGIN_REF}" &>/dev/null; then
  echo "→ uninstalling the existing '${PLUGIN_REF}' (scope=${SCOPE})"
  claude plugin uninstall "${PLUGIN_REF}" --scope "${SCOPE}" || true
fi

echo "→ installing '${PLUGIN_REF}' (scope=${SCOPE})"
claude plugin install "${PLUGIN_REF}" \
  --config "endpoint=${ENDPOINT}" \
  --config "token=${TOKEN}" \
  --scope "${SCOPE}"
echo "✓ '${PLUGIN_REF}': installed"

echo "→ verifying"
claude plugin details "${PLUGIN_REF}" || true

# ── 6. Allow the tools without a prompt ──────────────────────────────────────
SETTINGS_FILE="${HOME}/.claude/settings.json"
if [[ ! -f "${SETTINGS_FILE}" ]]; then
  echo "! ${SETTINGS_FILE} not found - skipping permission registration" >&2
elif ! command -v jq &>/dev/null; then
  echo "! jq not found - skipping permission registration" >&2
else
  echo "→ allowing the ${#MCP_TOOLS[@]} tools in ${SETTINGS_FILE}"
  tools_json="$(printf '%s\n' "${MCP_TOOLS[@]}" | jq -R . | jq -s .)"
  tmp="$(mktemp)"
  # Drop any entry from an older install of this plugin before adding the
  # current set, so renamed tools do not linger as dead permissions.
  jq --argjson new_tools "${tools_json}" --arg prefix "${TOOL_PREFIX}" '
    .permissions.allow = (
      [ (.permissions.allow // [])[] | select(startswith($prefix) | not) ] + $new_tools
      | unique
    )
  ' "${SETTINGS_FILE}" > "${tmp}" && mv "${tmp}" "${SETTINGS_FILE}"
  echo "✓ permissions registered"
fi

cat <<EOF

------------------------------------------------------------------
Done.

  endpoint : ${ENDPOINT}
  scope    : ${SCOPE}
  tools    : ${#MCP_TOOLS[@]} (web_search, web_scrape, web_crawl, ...)

Restart Claude Code to pick the tools up.
------------------------------------------------------------------
EOF
