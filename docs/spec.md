---
description: "External contract of the searxng-crawl4ai-mcp server: transports, authentication, the seven MCP tools (inputs, outputs, limits), failure kinds, outbound policy, configuration variables and metric names. Read before changing tool behaviour, schemas, error handling, configuration or metrics."
updated: 2026-10-19
keywords: [MCP, tools, web_search, web_scrape, web_crawl, failure kind, FailureKind, env, environment variables, metrics, Prometheus, SSRF, egress]
---

# searxng-crawl4ai-mcp specification

## Overview

The server is an MCP server that exposes seven read-only web tools (search, fetch, crawl, link listing, structured extraction) backed by an unmodified SearXNG and an unmodified Crawl4AI, reached only over their documented HTTP APIs. It is stateless. It speaks Streamable HTTP with a bearer token, or stdio, and both transports expose the same seven tools from the same factory (`buildServer` in `src/server.ts`). Failures are returned as values carrying one of ten failure kinds, never thrown at the client. How the server is built and deployed is in `docs/plan.md`.

## Transports and the HTTP endpoint

`MCP_TRANSPORT` selects the transport: `http` (default) or `stdio`.

| | `http` | `stdio` |
|---|---|---|
| Started by | the container runtime | the MCP client |
| Bearer token (`MCP_AUTH_TOKEN`) | required | not used |
| Host/Origin allow-list (`MCP_ALLOWED_HOSTS`) | required | not used |
| Metrics listener (`METRICS_PORT`) | available | never started |
| Tools | the seven in `TOOL_NAMES` | the same seven |

The HTTP listener (`startHttpServer` in `src/transport/http.ts`) handles each request in this order:

1. `GET /` answers `200` with `{name, version, status: "ok"}` without authentication. It is the health route.
2. Any path other than `/mcp` answers `404` with `{error: "not_found"}`.
3. The `Host` header is checked against `MCP_ALLOWED_HOSTS`; a mismatch answers `{error: "host_not_allowed"}`.
4. The `Origin` header is checked against `MCP_ALLOWED_HOSTS`; a mismatch answers `{error: "origin_not_allowed"}`.
5. `Authorization: Bearer <token>` is compared with `MCP_AUTH_TOKEN` in constant time; a mismatch answers `401` with `{error: "unauthorized"}` and `WWW-Authenticate: Bearer realm="mcp"`.
6. The request is handed to the MCP SDK handler. A fresh `McpServer` is built per connection.

The listener binds all interfaces on `PORT`. The deployment publishes it on host loopback only (`docs/plan.md`, "Container topology"). SIGINT and SIGTERM close the listener and exit; a forced exit follows after 10 seconds.

## Common tool contract

- Every tool is registered with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. No tool declares an `outputSchema`.
- Every input schema is strict: an unknown argument is rejected. A value that violates the schema never reaches the tool: the MCP SDK answers it with a result carrying `isError: true` and the plain text `Input validation error: Invalid arguments for tool <name>: <reason>`, without `structuredContent`. That reply is the SDK's and is the one result that is not JSON. A well-formed value the server cannot act on is answered by the tool as the failure kind `invalidInput`. No tool accepts `format`, so a call that passes it is rejected as a schema violation.
- Every result the tools produce, successful or not, carries `content: [{type: "text", text}]` and `structuredContent`. `text` is `JSON.stringify(structuredContent)` with no indentation; the two always agree. There is no markdown rendering of a result.
- `structuredContent` is the tool's structured result followed by two fields: `truncated` (boolean) and `truncation` (an object, or `null` when nothing was cut). See "Response size cap and truncation".
- A whole-call failure carries `isError: true` and `structuredContent = {status: "failed", failure: {kind, message, upstreamStatus}, truncated, truncation}`.
- Per-URL failures inside `web_batch_scrape`, `web_crawl` and `web_search_and_scrape` are not whole-call failures: each document carries its own `status` and `failure`, and the call succeeds.
- A fetched document (`FetchedDocument` in `src/upstream/types.ts`) has `url`, `finalUrl` (after redirects, or `null`), `status` (`"ok"` or `"failed"`), `markdown`, `title`, `links` and `failure`. `markdown` is the page's readable content as a string value.
- Every tool takes `maxChars` (integer, 25,000-500,000, default 25,000): the size cap for that call ("Response size cap and truncation"). A value outside the range is a schema violation.
- The tools that return page markdown (`web_scrape`, `web_search_and_scrape`, `web_batch_scrape`, `web_crawl`, and `web_extract` when degraded) take `keepLinks` (boolean, default `false`). By default a link `[text](url "title")` becomes `text` and an image `![alt](src)` becomes `alt` (nothing when `alt` is empty); the conversion happens while the HTML is turned into markdown, so text that only looks like a link (inside code, or escaped brackets) is left as it is. With `keepLinks: true` links and images stay as they were. `keepLinks` does not affect a `links` list returned beside the markdown, nor the links `web_crawl` follows.

## Response size cap and truncation

The cap is `maxChars` when the call gives it, otherwise `CHARACTER_LIMIT` (`src/constants.ts`, 25,000 characters); `maxChars` can only raise it, up to `MAX_CHARACTER_LIMIT` (500,000). It is counted as the `.length` (UTF-16 code units) of `text`. No tool declares `_meta["anthropic/maxResultSizeChars"]`, so a client such as Claude Code that moves a result over 50,000 characters to a file keeps doing so for a raised cap. The cap is enforced on the serialised JSON, escapes included, so `text` is never longer than the cap and is always valid JSON. `structuredContent` holds exactly what `text` holds: nothing removed from one is kept in the other.

A result that would be longer is reduced inside its structure, never by cutting the serialised string (`fit` in `src/utils/fit.ts`). Each tool lists the reductions it allows, and they are applied in order, each only while the result is still over the cap:

| Tool | Reductions, in order |
|---|---|
| `web_search` | drop trailing `results`, then `answers`, then `suggestions`, then `unresponsiveEngines` |
| `web_scrape` | shorten `markdown` from its end |
| `web_extract` | with `GEMINI_API_KEY`: drop trailing elements of `data` when it is an array, then set `data` to `null`; without it: shorten `markdown` from its end |
| `web_map` | drop trailing `external`, then trailing `internal` |
| `web_batch_scrape`, `web_crawl` | reduce `documents` (below) |
| `web_search_and_scrape` | reduce `documents` (below), then drop trailing `search.results` |

Reducing `documents` keeps every document while it can:

1. Every document's `links` becomes `{internal: [], external: []}` (a `null` stays `null`).
2. The space left for page bodies is shared max-min fairly: a body shorter than an equal share is kept whole, and the rest are cut from their end to the same length. So a short page is never cut to make room for a long one.
3. Only when the documents do not fit even with every body empty are documents dropped from the end of the array; the documents that remain then share the space as in step 2.

If the listed reductions are not enough (an unusually long title, for example), every string value in the result is shortened max-min fairly as a last step.

When anything was cut, `truncated` is `true` and `truncation` is:

```json
{
  "limit": 25000,
  "originalLength": 61234,
  "cuts": [
    {"path": "/documents/*/links/internal", "unit": "items", "original": 812, "kept": 0},
    {"path": "/documents/3/markdown", "unit": "chars", "original": 30512, "kept": 4980}
  ],
  "advice": "The response exceeded the size limit and was reduced; cuts lists what was removed. Narrow the request - fewer URLs, a lower page limit, or a more specific query - or raise maxChars (at most 500000)."
}
```

- `limit` is the cap in force for the call (`maxChars` or the default); `originalLength` is the length `text` would have had without any cut.
- Each cut names a JSON Pointer (RFC 6901) `path`; a `*` segment stands for every element of the array, and `""` for the whole result. `unit` is `"chars"` (a string shortened or set to `null`, counted in UTF-16 code units, or another value set to `null`, counted as its serialised length) or `"items"` (array elements dropped from the end). `original` and `kept` are in that unit.
- Cuts are listed in the order they were made. Only documents whose body was actually shortened get a cut.
- Counters that describe the work done (`pagesFetched` in `web_crawl`, `okCount` and `failedCount` in `web_batch_scrape`) are not changed by a cut, so `documents` may hold fewer entries than they count; the `/documents` cut gives the original number.

`truncated` and `truncation` are about the size cap only; tool-level flags such as `web_map`'s `limitReached` and `web_search`'s `coverage` are separate.

## Failure kinds

`FailureKind` in `src/utils/errors.ts` is the complete set. A failure is `{kind, message, upstreamStatus}`; `upstreamStatus` is the status code returned by the upstream or target, or `null`. Messages never contain credentials.

| Kind | Meaning | What the caller should do |
|---|---|---|
| `egressDenied` | Refused by the outbound address policy ("Outbound request policy"), or the scheme is not http/https | Do not retry; the target is not allowed |
| `unreachable` | Name resolution or connection failed | Retry later or check the URL |
| `httpError` | The target answered 4xx/5xx, or produced no readable content | Read `upstreamStatus`; a 404 means the page does not exist |
| `timeout` | The target did not finish in time | Retry later or narrow the request |
| `blocked` | The target refused automated access (403, 429 or an anti-bot page) | Do not retry immediately |
| `concurrencyLimit` | All fetch slots are busy ("Concurrency limit") | Retry shortly, or send fewer URLs per call |
| `upstreamUnavailable` | SearXNG or Crawl4AI is down or misconfigured | Needs an operator |
| `invalidInput` | A well-formed argument that cannot be acted on: an unparsable or uncrawlable URL | Fix the argument |
| `loginInProgress` | A manual login is in progress on the server and fetching is paused ("Logged-in fetching") | Retry after the login ends |
| `loginRequired` | The target redirected to a sign-in page; the saved login is missing or expired | An operator must log in again |

## Tool web_search

Searches several engines through SearXNG and returns titles, URLs and snippets. An empty result list is an answer, not an error.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `query` | string | required | 1-512 chars |
| `limit` | integer | 10 | 1-50 |
| `language` | string | `"auto"` | max 16 chars; `"auto"` is not sent upstream, so SearXNG's `search.default_lang` applies (`en` in `docker/searxng/settings.yml`) |
| `categories` | string[] | `["general"]` | max 8 items, each max 32 chars; ignored when `engines` is given |
| `engines` | string[] | omitted | 1-16 items, each 1-48 chars; names are not validated; replaces `categories` |
| `timeRange` | `"day"`/`"week"`/`"month"`/`"year"` | omitted | |
| `safesearch` | integer | omitted (instance setting) | 0 off, 1 moderate, 2 strict |

Output (`SearchResult` in `src/upstream/types.ts`): `query`, `results[]` (`title`, `url`, `snippet`, `engines[]`, `score` or `null`), `answers[]`, `suggestions[]`, `unresponsiveEngines[]` (`engine`, `reason`; one entry per engine across pages), and `coverage`.

`coverage` is always present: `requested`, `returned`, `pagesFetched`, `satisfied`, `shortfall`. `satisfied` is true exactly when `shortfall` is `null`. `ShortfallReason`:

| `shortfall` | Meaning |
|---|---|
| `exhausted` | A page added no new unique URL: the engines have no more |
| `page_limit` | `SEARCH_MAX_PAGES` (5) result pages were read without reaching `limit` |
| `time_budget` | `SEARCH_TIME_BUDGET_MS` (45 seconds) was spent; checked between pages |
| `upstream_failed` | A later page failed; what had been gathered is returned |

Results are de-duplicated by exact URL across pages. If the first page fails, the whole call fails. Each page request has a 30-second timeout. A SearXNG `403` is reported as `upstreamUnavailable` with a hint that `search.formats` in `settings.yml` must list `json`.

## Tool web_scrape

Fetches one page and returns its readable content as markdown, rendering JavaScript.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `url` | URL | required | |
| `keepLinks` | boolean | `false` | see "Common tool contract" |

Output is one `FetchedDocument` with `status: "ok"`, readable markdown (boilerplate and images removed) and `links: null`. A failed fetch is a whole-call failure.

## Tool web_search_and_scrape

Searches, then fetches the top hits in one call.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `query` | string | required | 1-512 chars |
| `topN` | integer | 3 | 1-10; also the search `limit` |
| `language` | string | `"auto"` | max 16 chars |
| `engines`, `timeRange`, `safesearch` | as in "Tool web_search" | omitted | |
| `keepLinks` | boolean | `false` | see "Common tool contract" |

There is no `categories` and no `limit`. Output: `{search: SearchResult, documents: FetchedDocument[]}`, documents in hit order. A hit refused by the outbound policy, or without a result, is a failed document; the call still succeeds. Zero hits returns `documents: []`. Documents carry the full (unfiltered) markdown, with links only when `keepLinks` is true.

## Tool web_batch_scrape

Fetches a list of pages; each URL succeeds or fails on its own.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `urls` | URL[] | required | 1-20 items |
| `keepLinks` | boolean | `false` | see "Common tool contract" |

Output: `{documents, okCount, failedCount}`, documents in input order. A batch in which every URL failed is still not a whole-call failure. The whole batch uses one fetch slot. Documents carry the full (unfiltered) markdown, with links only when `keepLinks` is true.

## Tool web_crawl

Starts at a URL and follows links level by level, synchronously.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `url` | URL | required | http or https |
| `maxDepth` | integer | 2 | 1-5 link hops |
| `maxPages` | integer | 20 | 1-100 pages |
| `sameHostOnly` | boolean | `true` | compares `URL.host` |
| `keepLinks` | boolean | `false` | see "Common tool contract"; links are followed either way |

Output: `{start, state: "completed", pagesFetched, depthReached, stoppedAt, documents}`. `start` is the start URL without its fragment. `pagesFetched` counts failed pages too. Reaching a cap ends the crawl normally. `stoppedAt`:

| `stoppedAt` | Meaning |
|---|---|
| `pages` | `maxPages` was reached; more pages remain |
| `depth` | `maxDepth` was reached; deeper pages were not followed |
| `exhausted` | Every reachable link within the limits was followed |

Only internal links are followed, fragments are dropped, and only http/https links are kept. A start URL refused by the outbound policy, or not crawlable, is a whole-call failure. Per-page failures stay in `documents`. The crawl runs to completion within the call; there is no background mode.

## Tool web_map

Fetches a page and lists the URLs it links to, without the page body.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `url` | URL | required | |
| `limit` | integer | 100 | 1-500 |
| `includeExternal` | boolean | `false` | |

Output: `{url, internal[], external[], limitReached}`, each list de-duplicated in page order. Internal links come first up to `limit`; external links fill what remains of `limit`, only when `includeExternal` is true. `limitReached` is `true` when the page has more links than were returned because of `limit`; it is separate from `truncated`, the size-cap flag. A failed fetch is a whole-call failure.

## Tool web_extract

Pulls fields described in plain language out of a page, using the LLM configured for Crawl4AI.

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `url` | URL | required | |
| `instruction` | string | required | 1-2000 chars |
| `keepLinks` | boolean | `false` | applies only to the degraded `markdown`; see "Common tool contract" |

With `GEMINI_API_KEY` set, the output is `{url, data, degraded: false, markdown: null, failure: null}`, where `data` is the upstream JSON as returned (shape not fixed). The extraction request has a 180-second timeout. Without `GEMINI_API_KEY`, the tool does not fail: it returns `{url, data: null, degraded: true, markdown, failure: null}` with the page's readable markdown, and `instruction` is unused. `web_extract` does not detect an expired login, because the upstream does not return the final URL.

## Outbound request policy

Before fetching, every target URL is checked by `checkEgress` (`src/security/egress.ts`):

1. An unparsable URL is `invalidInput`; a scheme other than http/https is `egressDenied`.
2. A literal IP is used as is; a name is resolved with all its addresses. A failed or empty resolution is `unreachable`.
3. Every resolved address is checked. An address inside `SCRAPE_ALLOW_CIDRS` is allowed; otherwise an address inside `DENIED_CIDRS` (`src/security/ranges.ts`) is `egressDenied`. IPv4-mapped IPv6 addresses are checked as IPv4.

`DENIED_CIDRS` is compiled in and cannot be narrowed by configuration: `127.0.0.0/8`, `::1/128`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `169.254.0.0/16`, `fe80::/10`, `100.64.0.0/10`, `0.0.0.0/8`, `::/128`, `192.0.0.0/24`, `198.18.0.0/15`, `240.0.0.0/4`, `224.0.0.0/4`, `ff00::/8`, `::ffff:0:0/96`. `SCRAPE_ALLOW_CIDRS` can only widen what is allowed.

This check produces a clear error; it is not the security boundary, because a name can resolve differently after the check, and redirect targets are not checked. The boundary is the host packet filter (`docs/plan.md`, "Egress guard").

## Concurrency limit

Page-fetching tools run inside a fixed number of fetch slots, `MAX_CONCURRENT_FETCHES` (default 4, range 1-32). One tool call takes one slot regardless of how many URLs it carries; `web_crawl` takes one slot per sub-batch of five pages. When no slot is free the call is rejected immediately, without queueing, as `concurrencyLimit`.

## Upstream retry as seen by a caller

A request to SearXNG or Crawl4AI that fails quickly with a transient error is retried with backoff. A request that used up its own timeout is not retried. Retrying never adds more than `RETRY_WAIT_BUDGET_MS` (2 seconds) to one upstream request, including any `Retry-After` the upstream asked for. `RETRY_MAX_ATTEMPTS` (default 3, including the first; 0 or 1 turns retrying off) sets the attempts. The stages are in `docs/plan.md`, "Upstream retry policy".

## Logged-in fetching

When `LOGIN_STATE_DIR` is set, every Crawl4AI operation (all tools except `web_search`) first checks the login state directory:

- If `.session-root` is missing, the call fails with `upstreamUnavailable` ("check that the session disk is mounted").
- If `login-in-progress` exists, the call fails with `loginInProgress`. For `web_search_and_scrape` the search has already run, but the call fails as a whole.

A fetched page whose final URL looks like a sign-in page, while the requested URL did not, becomes a failed document with `loginRequired` (unless its status is 400 or higher). The check looks only at the URL shape (`isLoginRedirect` in `src/upstream/login-detect.ts`): a path segment such as `signin`, `login`, `logon`, `sso` or `authorize`, a first host label such as `login`, `signin`, `sso` or `auth`, or a query value `login`. A sign-in form shown without a redirect is not detected. For `web_scrape`, `web_map` and degraded `web_extract`, `loginRequired` is a whole-call failure; for the multi-document tools it is a per-document failure. Neither state appears as a separate boolean field. The operator workflow is in `README.md`, "Logged-in fetching (optional)", and the mechanism is in `docs/plan.md`, "Login session design".

## Configuration variables

The server reads these variables, validated at startup by `validateEnv` (`src/utils/env.ts`). An empty or whitespace-only value counts as unset. An invalid configuration exits with status 1 and prints only the variable names.

| Variable | Default | Required | Effect |
|---|---|---|---|
| `MCP_TRANSPORT` | `http` | no | `http` or `stdio` |
| `MCP_AUTH_TOKEN` | - | with `http` | Bearer token, min 16 chars |
| `MCP_ALLOWED_HOSTS` | - | with `http` | Comma-separated Host/Origin allow-list |
| `SEARXNG_URL` | - | yes | SearXNG base URL |
| `CRAWL4AI_URL` | - | yes | Crawl4AI base URL |
| `CRAWL4AI_API_TOKEN` | - | yes | Bearer token sent to Crawl4AI, min 16 chars |
| `PORT` | 3000 | no | HTTP listen port |
| `GEMINI_API_KEY` | - | no | Presence switches `web_extract` from degraded to LLM extraction |
| `GEMINI_MODEL` | `gemini/gemini-flash-lite-latest` | no | Validated; consumed by Crawl4AI through compose, not by the server |
| `PROXY_URL` | - | no | Validated; consumed by SearXNG and Crawl4AI through compose; the server's own requests ignore it |
| `LOGIN_STATE_DIR` | - | no | Absolute path; enables "Logged-in fetching" |
| `SCRAPE_ALLOW_CIDRS` | empty | no | Comma-separated CIDRs allowed despite `DENIED_CIDRS` |
| `MAX_CONCURRENT_FETCHES` | 4 | no | Fetch slots, 1-32 |
| `RETRY_MAX_ATTEMPTS` | 3 | no | Upstream attempts including the first, 0-5 |
| `LOG_LEVEL` | `info` | no | pino level `trace`-`fatal`, logged to stderr; applied after validation, so an unknown value is refused at start like any other invalid variable |
| `METRICS_PORT` | - | no | Starts the metrics listener (http transport only) |
| `METRICS_HOST` | `127.0.0.1` | no | Metrics bind address |

`.env.example` documents the variables an operator sets for the whole stack, including ones only compose or the installers read (`SEARXNG_SECRET`, `CRAWL4AI_MEM_LIMIT`, `MCP_PUBLIC_ENDPOINT`, `MCP_PUBLIC_AUTH_TOKEN`). Values set by compose (`SEARXNG_URL`, `CRAWL4AI_URL`, `LOGIN_STATE_DIR`, `METRICS_HOST`) are not in it.

## Metrics

When `METRICS_PORT` is set and the transport is `http`, a separate unauthenticated listener on `METRICS_HOST:METRICS_PORT` serves `GET /metrics` in Prometheus format; other paths answer 404. Recording never throws and is a no-op until the listener is up. Default process metrics are included. Metrics defined in `src/metrics/registry.ts`:

| Metric | Type | Labels |
|---|---|---|
| `mcp_tool_calls_total` | counter | `tool`, `result` |
| `mcp_tool_failures_total` | counter | `tool`, `kind` |
| `mcp_tool_duration_seconds` | histogram | `tool` |
| `mcp_search_results_total` | counter | `outcome` (`hits`, `empty`) |
| `mcp_search_engine_unresponsive_total` | counter | `engine` (40 distinct, then `other`), `reason` (`captcha`, `timeout`, `suspended`, `error`, `other`) |
| `mcp_search_shortfall_total` | counter | `reason` (the `ShortfallReason` values) |
| `mcp_documents_total` | counter | `result` (`ok`, `failed`) |
| `mcp_upstream_requests_total` | counter | `upstream`, `result` |
| `mcp_upstream_duration_seconds` | histogram | `upstream`, `operation` (`search`, `markdown`, `crawl`, `extract`) |
| `mcp_upstream_retries_total` | counter | `upstream`, `reason` (`connect`, `http_5xx`, `rate_limited`, `timeout`) |
| `mcp_fetch_slots_in_use` | gauge | - |
| `mcp_fetch_slots_limit` | gauge | - |
| `mcp_concurrency_rejected_total` | counter | - |
| `mcp_login_session_enabled` | gauge | - |
| `mcp_login_required_total` | counter | - |

A tool result whose `structuredContent.failure` is set counts as a failure in `mcp_tool_calls_total`.

## Non-goals

- No response cache, no database and no background jobs; every tool answers within its call.
- No calls into SearXNG or Crawl4AI internals and no deep-crawl strategy sent upstream.
- No per-site login rules or stored site credentials.
- No rate limiting, CORS or request-body limit in the HTTP listener; the reverse proxy and the bearer token front it.

## Known gaps

None are recorded as of 2026-10-16. A gap is an inconsistency inside the code; this document specifies the code's behaviour, and a gap found later is listed here with where it is.

## References

- `src/server.ts`, `src/tools/`, `src/schemas/tools.ts`: tool registration, behaviour and input schemas.
- `src/utils/errors.ts`, `src/utils/fit.ts`, `src/constants.ts`: failure kinds, truncation and limits.
- `src/transport/http.ts`, `src/transport/stdio.ts`, `src/security/`: transports, authentication and outbound policy.
- `src/upstream/`: upstream clients, search paging, login detection and gating.
- `src/utils/env.ts`, `.env.example`: configuration.
- `src/metrics/`: metric definitions and listener.
- `README.md`: operator-facing setup and usage.
