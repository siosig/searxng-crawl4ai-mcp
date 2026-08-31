# searxng-crawl4ai-mcp

A self-hosted MCP server that gives an AI agent web search and page fetching,
without depending on any commercial search or scraping API.

It is deliberately a **thin layer**. SearXNG and Crawl4AI are run as their
official container images and are spoken to over their documented HTTP APIs.
This repository contains no wrapper around their internals, which is what makes
it possible to follow their releases instead of drifting away from them.

## Why this exists

The obvious way to build this is to import the scraping library and call it
directly. That is what the project this replaces did, and it is why that project
stopped being maintainable: every upstream release changed an internal API, the
wrapper broke, and nothing noticed until a search quietly returned nothing.

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
| `web_search` | Search the web across multiple engines |
| `web_scrape` | Fetch one page as markdown |
| `web_search_and_scrape` | Search, then fetch the top results |
| `web_batch_scrape` | Fetch several pages, reporting per-URL success |
| `web_crawl` | Crawl a site with depth and page limits |
| `web_map` | List the URLs under a site |
| `web_extract` | Pull structured fields out of a page |
| `web_job_status` | Check a long-running crawl |

Failures are returned, not thrown, and carry a machine-readable reason so the
caller can tell "the site is down" apart from "that target is not allowed".

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

## Migrating from the previous server

Tool names changed and two merged. See [docs/migration.md](docs/migration.md).

## License

MIT
