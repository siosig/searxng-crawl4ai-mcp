# Migrating from the previous server

The tools were renamed and two of them merged, so an MCP client pointed at the
old server needs its tool list updated. Nothing else changes for a caller.

## Tool names

| Before | Now | Note |
|--------|-----|------|
| `search_web` | `web_search` | |
| `search_and_scrape` | `web_search_and_scrape` | |
| `scrape_url` | `web_scrape` | merged |
| `crawl4ai_scrape` | `web_scrape` | merged - the two were the same call |
| `batch_scrape` | `web_batch_scrape` | |
| `crawl_website` | `web_crawl` | |
| `map_website` | `web_map` | |
| `extract_structured_data` | `web_extract` | |
| `get_crawl_status` | `web_job_status` | |

Nine tools became eight: `scrape_url` and `crawl4ai_scrape` did the same thing
under two names, which left a caller guessing which to reach for.

## Behaviour worth knowing about

**Failures are values, not exceptions.** Every tool returns a result carrying a
`failure.kind`. In particular `egressDenied` (policy refused this target) is
distinct from `unreachable` (the site did not answer), so a blocked URL is never
mistaken for a broken site.

**Private addresses are refused by default.** The previous server would fetch
anything. This one refuses private, loopback, link-local, carrier-NAT and cloud
metadata addresses unless an operator has explicitly allowed a range.

**`web_crawl` reports why it stopped.** `stoppedAt` is `pages`, `depth` or
`exhausted`, so a truncated crawl is visible rather than looking complete.

**`web_extract` degrades instead of failing.** With no language-model
credentials it returns the page content and sets `degraded: true`.

**Responses are capped at 25,000 characters** and say so when cut.

## Operational differences

- Upstream versions live in `versions.env` and nowhere else.
- The target host pulls a published image; it no longer builds anything.
- `CRAWL4AI_API_TOKEN` is required. Without it Crawl4AI listens only on its own
  loopback interface and the stack cannot reach it - while still reporting
  itself healthy.
- Redis is gone. The previous stack ran it; nothing needed it.
