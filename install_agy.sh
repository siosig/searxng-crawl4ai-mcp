#!/usr/bin/env bash
#
# install_agy.sh - register this checkout with Antigravity (agy) as an MCP server.
#
# The MCP server runs elsewhere (Streamable HTTP with a bearer token), so nothing
# is built here: this script registers the remote MCP server with Antigravity CLI
# via `agy mcp add --header "Authorization: Bearer ..." --type http`.
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
# Environment variables override .env when set:
#   SEARXNG_CRAWL4AI_ENDPOINT       endpoint URL
#   SEARXNG_CRAWL4AI_ACCESS_TOKEN   bearer token
#   SEARXNG_CRAWL4AI_ENV_FILE       path to the .env (default: alongside this script)
#   SKIP_CHECK=1                    skip the endpoint reachability check
#
# Usage:
#   ./install_agy.sh                # install / update MCP server registration
#   ./install_agy.sh -d             # uninstall MCP server registration
#   ./install_agy.sh -h             # show help
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || pwd)"
ENV_FILE="${SEARXNG_CRAWL4AI_ENV_FILE:-${REPO_DIR}/.env}"
SERVER_NAME="searxng-crawl4ai"

# The eight tools this server exposes. Kept in sync with src/server.ts.
MCP_TOOLS=(
  "web_search"
  "web_scrape"
  "web_search_and_scrape"
  "web_batch_scrape"
  "web_crawl"
  "web_map"
  "web_extract"
  "web_job_status"
)

usage() {
  cat >&2 <<EOF
Usage: ${0##*/} [-d|--uninstall] [-h|--help]

  (no flag)        Register the searxng-crawl4ai MCP server with Antigravity (agy):
                     • agy mcp add --header "Authorization: Bearer ..." --type http
                   Validates that the endpoint is reachable unless SKIP_CHECK=1.
  -d, --uninstall  Remove the MCP server from Antigravity:
                     • agy mcp remove ${SERVER_NAME}
  -h, --help       Show this help.

Env overrides:
  SEARXNG_CRAWL4AI_ENDPOINT      Endpoint URL (overrides .env)
  SEARXNG_CRAWL4AI_ACCESS_TOKEN  Bearer token (overrides .env)
  SEARXNG_CRAWL4AI_ENV_FILE      Path to .env (default: ${REPO_DIR}/.env)
  SKIP_CHECK=1                   Skip endpoint reachability check
EOF
}

MODE="install"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--uninstall|--delete) MODE="uninstall" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

_require() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found. Install it and try again." >&2
    [[ -n "${2:-}" ]] && echo "       $2" >&2
    exit 1
  fi
  echo "✓ $1: $(command -v "$1")"
}

# ── Uninstall ────────────────────────────────────────────────────────────────
if [[ "${MODE}" == "uninstall" ]]; then
  echo "→ uninstalling MCP server '${SERVER_NAME}' from Antigravity"
  _require agy "https://antigravity.google/"

  if agy mcp list 2>/dev/null | grep -q "^${SERVER_NAME}[[:space:]]"; then
    agy mcp remove "${SERVER_NAME}" >/dev/null 2>&1 || true
    echo "✓ MCP server '${SERVER_NAME}': removed"
  else
    echo "✓ MCP server '${SERVER_NAME}': not registered (skip)"
  fi

  echo ""
  echo "Uninstall complete. Restart Antigravity to refresh the MCP toolset."
  exit 0
fi

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
_require agy "https://antigravity.google/"

# ── 2. Configuration ─────────────────────────────────────────────────────────
# Read one KEY=VALUE from the .env without executing it.
_env_get() {
  [[ -f "${ENV_FILE}" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "${ENV_FILE}" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

if [[ -n "${SEARXNG_CRAWL4AI_ENDPOINT:-}" ]]; then
  ENDPOINT="${SEARXNG_CRAWL4AI_ENDPOINT}"
  ENDPOINT_SRC="env SEARXNG_CRAWL4AI_ENDPOINT"
else
  ENDPOINT="$(_env_get MCP_PUBLIC_ENDPOINT)"
  ENDPOINT_SRC="${ENV_FILE} MCP_PUBLIC_ENDPOINT"
fi

if [[ -n "${SEARXNG_CRAWL4AI_ACCESS_TOKEN:-}" ]]; then
  TOKEN="${SEARXNG_CRAWL4AI_ACCESS_TOKEN}"
  TOKEN_SRC="env SEARXNG_CRAWL4AI_ACCESS_TOKEN"
else
  TOKEN="$(_env_get MCP_PUBLIC_AUTH_TOKEN)"
  TOKEN_SRC="${ENV_FILE} MCP_PUBLIC_AUTH_TOKEN"
  if [[ -z "${TOKEN}" ]]; then
    TOKEN="$(_env_get MCP_AUTH_TOKEN)"
    TOKEN_SRC="${ENV_FILE} MCP_AUTH_TOKEN"
  fi
fi

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
echo "✓ endpoint: ${ENDPOINT} (from ${ENDPOINT_SRC})"
echo "✓ token: set (from ${TOKEN_SRC})"

# ── 3. Endpoint reachability ─────────────────────────────────────────────────
if [[ "${SKIP_CHECK:-0}" != "1" ]] && command -v curl &>/dev/null; then
  echo "→ checking the endpoint answers an authenticated tools/list"
  code="$(curl -sS -o /tmp/.mcp_probe.$$ -w '%{http_code}' --max-time 20 \
    -X POST "${ENDPOINT}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    -H 'Mcp-Method: tools/list' \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"install_agy.sh","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' \
    2>/dev/null || echo "000")"
  body="$(cat /tmp/.mcp_probe.$$ 2>/dev/null || true)"; rm -f /tmp/.mcp_probe.$$
  case "${code}" in
    200) echo "✓ endpoint: reachable, tools advertised: $(grep -o '"name":"web_[a-z_]*"' <<<"${body}" | wc -l)" ;;
    401) echo "ERROR: the endpoint rejected the token (HTTP 401)." >&2
         echo "       The token came from ${TOKEN_SRC}." >&2
         if [[ "${TOKEN_SRC}" == env\ * ]]; then
           echo "       That variable wins over ${ENV_FILE}; unset it to use the file." >&2
         fi
         exit 1 ;;
    000) echo "ERROR: could not reach ${ENDPOINT}." >&2
         echo "       Set SKIP_CHECK=1 to install anyway." >&2; exit 1 ;;
    *)   echo "ERROR: the endpoint answered HTTP ${code} (expected 200)." >&2
         echo "       ${body:0:300}" >&2
         echo "       Set SKIP_CHECK=1 to install anyway." >&2; exit 1 ;;
  esac
else
  echo "✓ endpoint check: skipped"
fi

# ── 4. Register MCP server in Antigravity (idempotent) ────────────────────────
echo "→ registering MCP server '${SERVER_NAME}' in Antigravity"
# Remove existing entry first to ensure clean update
agy mcp remove "${SERVER_NAME}" >/dev/null 2>&1 || true

agy mcp add --header "Authorization: Bearer ${TOKEN}" --type http "${SERVER_NAME}" "${ENDPOINT}"
echo "✓ MCP server '${SERVER_NAME}': registered"

# Verify registration
echo "→ verifying MCP server configuration"
agy mcp list | grep -E "^(NAME|${SERVER_NAME})[[:space:]]" || true

cat <<EOF

------------------------------------------------------------------
Done.

  server   : ${SERVER_NAME}
  endpoint : ${ENDPOINT}
  tools    : ${#MCP_TOOLS[@]} (${MCP_TOOLS[*]})

Restart Antigravity (agy) to pick the tools up.
To uninstall: ${0##*/} -d
------------------------------------------------------------------
EOF
