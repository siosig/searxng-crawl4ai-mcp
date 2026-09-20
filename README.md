# searxng-crawl4ai-mcp

A self-hosted MCP server that gives an AI agent web search and page fetching,
without depending on any commercial search or scraping API.

It is deliberately a **thin layer**. SearXNG and Crawl4AI are run as their
official container images and are spoken to over their documented HTTP APIs.
This repository contains no wrapper around their internals, which is what makes
it possible to follow their releases instead of drifting away from them.

## Why this exists

The obvious way to build this is to import the scraping library and call it
directly. That road ends badly, and predictably: every upstream release changes
an internal API, the wrapper breaks, and nothing notices until a search quietly
returns nothing.

So the constraint here is stated up front and enforced by tests:

- **No code calls upstream internals.** Only documented HTTP endpoints.
- **Upstream versions are declared in exactly one file**, `versions.env`.
  Moving to a new release means editing a tag there and nothing else.
- **Every version change is verified before it reaches a running host**, by
  starting the real upstream containers and exercising all tools against them.

## Architecture

```
MCP client
   |  Streamable HTTP + bearer token
   v
reverse proxy  ->  mcp        this repository; the only code here
                    |
                    +-- HTTP -> searxng     official image, unmodified
                    +-- HTTP -> crawl4ai    official image, unmodified
```

Three containers, no database. The server holds no state: crawl job state lives
in Crawl4AI.

## Tools

| Tool | What it does |
|------|--------------|
| `web_search` | Search the web across multiple engines, optionally narrowed by engine, time range or safe-search level |
| `web_scrape` | Fetch one page as markdown |
| `web_search_and_scrape` | Search, then fetch the top results |
| `web_batch_scrape` | Fetch several pages, reporting per-URL success |
| `web_crawl` | Crawl a site with depth and page limits |
| `web_map` | List the URLs under a site |
| `web_extract` | Pull structured fields out of a page |
| `web_job_status` | Check a long-running crawl |

Failures are returned, not thrown, and carry a machine-readable reason so the
caller can tell "the site is down" apart from "that target is not allowed".

A search reports whether it actually returned the number of results it was
asked for, and when it did not, why: the results ran out, the page limit was
reached, the time budget was spent, or an upstream failed partway. An agent that
gets fewer results than it asked for can otherwise not tell "the web has no more
of this" from "this server stopped looking", and those call for opposite next
moves.

A request to SearXNG or Crawl4AI that fails quickly - a refused connection, a
502, a rate limit - is retried with backoff. One that fails by using up its own
timeout is not: repeating it would double a wait that has already proved too
long. The rule is a single budget rather than a list of special cases, so
retrying never adds more than two seconds to any call.
`web_crawl` also reports why it stopped - a page limit, a depth limit or nothing
left to visit - so a truncated crawl is visible instead of looking complete.
Responses are capped at 25,000 characters and say so when they were cut.

## Two ways to run it

| | Streamable HTTP | stdio |
|---|---|---|
| Who starts the process | the container runtime | the MCP client |
| Needs a bearer token | yes | no - there is no port to defend |
| Needs a Host allow-list | yes | no |
| Reachable from other machines | yes, through a reverse proxy | no |
| Tools exposed | the same eight | the same eight |

Both entries are built from the same server factory, so neither can grow a
capability the other lacks. `MCP_TRANSPORT` picks between them and defaults to
`http`; the deployed stack is unaffected by the existence of the other one.

stdio exists so that trying this out does not require issuing a token and
putting a reverse proxy in front of it. It is for one person on one machine:

```sh
MCP_TRANSPORT=stdio \
SEARXNG_URL=http://127.0.0.1:8081 \
CRAWL4AI_URL=http://127.0.0.1:11235 \
CRAWL4AI_API_TOKEN=... \
node dist/index.js
```

The outbound address policy, the fetch budget and the response size cap apply
identically in both. What stdio drops is only what a listener needed.

## Requirements

- Docker and Docker Compose
- Node.js 22 or newer, and pnpm, if you intend to work on the server itself

## Getting started

```sh
cp .env.example .env
# fill in MCP_AUTH_TOKEN, MCP_ALLOWED_HOSTS and SEARXNG_SECRET

docker compose --env-file versions.env --env-file .env -f docker/compose.yaml up -d
```

`.env` is gitignored and must stay that way. Every environment-specific value
lives there or in the deployment inventory, never in a tracked file.

## Following upstream releases

1. A scheduled job notices a new SearXNG or Crawl4AI release and opens a pull
   request that changes only `versions.env`.
2. CI starts the whole stack on that version and runs every tool against it.
3. If it passes, a human decides whether to deploy. Nothing is deployed
   automatically.

To roll back, restore the previous `versions.env` and redeploy. Image tags are
pinned, so the previous state is reproducible.

### When the contract tests fail after a bump

Several behaviours here exist only to work around something the upstream does
not do: the level-by-level crawl (Crawl4AI refuses a deep-crawl strategy from
any HTTP caller by design), the paging and de-duplication of search results,
the message-matching error classification, the override of Crawl4AI's
short-page block verdict, and a few more. Each one is pinned by a test in
`tests/contract/tier-a/upstream.test.ts` that fails the day its cause goes
away, and the test name says which guarantee was withdrawn.

So a red test after a version bump is information, not only breakage: it may
mean a workaround can now be removed. Read the failing test's name and the
comment on the code it guards before changing anything, and do not redo the
inventory by hand.

One check needs a model credential and is skipped, by name, wherever
`GEMINI_API_KEY` is not set - which includes CI. Run the contract tests once on
a machine that has the key before deploying a bump.

## Outbound request policy

Fetch targets are resolved to IP addresses before the request is made, and
private, loopback, link-local and cloud metadata ranges are refused. Additional
ranges can be allowed through configuration. A refusal is reported distinctly
from an unreachable host, so a blocked target is never mistaken for a broken
one.

Because a name can resolve differently after it has been checked, the
application-level check is a convenience that produces a clear error, not the
security boundary. The boundary is a packet filter applied on the host during
deployment.

## Deployment

`ansible/` deploys the stack to a single always-on Linux host. The playbook is
idempotent and pulls prebuilt images; it never builds on the target, which
matters when that target is a low-power machine.

## Connecting Claude Code

Two installers register this checkout with Claude Code as a plugin. Neither
builds anything: the plugin only tells Claude Code where the endpoint is and
which bearer token to present, then allows the eight tools without a prompt.
Both read `MCP_PUBLIC_ENDPOINT` and `MCP_PUBLIC_AUTH_TOKEN` (falling back to
`MCP_AUTH_TOKEN`) from the gitignored `.env`.

```sh
# Linux / macOS
./install_claude_plugin.sh
```

```powershell
# Windows - needs PowerShell 7 (pwsh), not Windows PowerShell 5.1
pwsh -ExecutionPolicy Bypass -File .\install_claude_plugin.ps1
```

`-ExecutionPolicy Bypass` matters when the checkout sits on a network share or
came in as a download, where `RemoteSigned` refuses to run it. Restart Claude
Code afterwards.

## Using with LLMs

All eight tools are exposed to any LLM client that understands MCP. The HTTP transport requires a bearer token; stdio is for local development and single-user setups.

### LLM configuration for structured extraction

`web_extract` uses Google's Gemini API to pull structured fields from pages. To enable it:

1. Get a free Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey)
2. Add to `.env`:
   ```
   GEMINI_API_KEY=<your-key>
   ```
3. Optionally override the model (default: `gemini-flash-lite-latest`):
   ```
   GEMINI_MODEL=gemini/gemini-2.0-flash
   ```

Without a key, `web_extract` degrades gracefully and returns the page as markdown. The other seven tools are unaffected and do not need LLM credentials.

### Tool selection guide

**Question answering**: Use `web_search_and_scrape` to search and read top results in one call. This is faster and more accurate than searching alone, since you get the full source pages with the results.

**Exploring a site**: Start with `web_map` to list links, then `web_scrape` or `web_crawl` to read. This avoids fetching pages you don't need.

**Single page**: `web_scrape` reads one page as markdown, rendering JavaScript. Use it for dynamic content that plain HTTP fetch cannot read.

**Multiple pages at once**: `web_batch_scrape` fetches a list of URLs in parallel. Unlike calling `web_scrape` repeatedly, a failure on one URL does not stop the others, and you get the reason for each failure.

**Crawling a site**: `web_crawl` follows links from a starting URL up to a depth and page limit. It stays on the same host by default. When a crawl hits a limit, it reports which one, so you know whether to raise the limit or stop.

**Extracting structured data**: `web_extract` pulls specific fields out of a page (e.g. "product name, price, availability") in plain language. When LLM credentials are not configured, it returns the page as markdown and leaves the reading to you.

**Long-running crawls**: `web_crawl` returns immediately with a `jobId`. Use `web_job_status` to poll for results. The same id always reports the same state, so polling is safe.

### Error handling

Every tool returns structured results with a `status` field: `"ok"`, `"failed"`, or `"partial"` (some URLs succeeded, others did not). When status is `"failed"`, a `failure` field describes why:

- `"access_denied"` — the target is on a private, loopback, link-local or cloud metadata range
- `"host_unreachable"` — DNS failed, the connection timed out, or the server is not listening
- `"http_error"` — the server responded with a 4xx or 5xx status
- `"parsing_failed"` — the content exists but could not be parsed as HTML or markdown
- `"response_size_exceeded"` — the response was larger than 25,000 characters (truncated in output)

Distinguish between these when deciding what to do next. "Access denied" means the target is blocked by policy; "host unreachable" means trying again later might work; "http_error" on a 404 means the page does not exist.

### Rate limiting and budgets

- Each tool call has a timeout (typically 30 seconds). Requests to SearXNG or Crawl4AI that fail quickly are retried with backoff, but those that exhaust their timeout are not, because repeating them would double the wait.
- Large crawls may return fewer pages than requested if they hit the page limit, depth limit, or time budget. The response reports which limit was reached.
- Responses are capped at 25,000 characters. When truncated, the output says so and you can `web_job_status` to retrieve the full results (for crawls) or re-fetch with different parameters.

## Development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Contract tests come in two tiers. Tier A runs against a fixture site inside CI
and gates merges. Tier B talks to the live internet, and is reported but not
gating, because a datacenter IP being blocked by a search engine says nothing
about whether this code is correct.

## License

MIT
