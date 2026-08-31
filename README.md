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
in Crawl4AI, and nothing is cached between calls.

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
