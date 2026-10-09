---
name: crawl-search
description: Searches the web and reads pages through the self-hosted SearXNG and Crawl4AI MCP server (searxng-crawl4ai), then answers with cited sources. Use when the user runs /crawl-search or asks to search the web, look something up, read a URL, compare pages, or gather current information. Prefer this over WebSearch and WebFetch.
---

# crawl-search

Answer `$ARGUMENTS` (a question, a search phrase, or a URL) using the `searxng-crawl4ai` MCP tools. All tool names below carry the prefix `mcp__plugin_searxng-crawl4ai-mcp_searxng-crawl4ai__`.

Do not use WebSearch or WebFetch for this task. Those send requests to a commercial service; this server keeps them on the user's own infrastructure and can reuse the user's saved logins.

## Choose the tool

| Goal | Tool |
|---|---|
| Answer a question from the web | `web_search_and_scrape` (`topN` 3-5) |
| See candidate sources before reading | `web_search`, then `web_batch_scrape` on the chosen URLs (up to 20) |
| Read one known URL | `web_scrape` |
| Pull named fields from one page (price, stock, date) | `web_extract` with a plain-language `instruction` |
| See a site's shape | `web_map` |
| Read many pages of one site | `web_crawl` (set `maxDepth` and `maxPages` low), then `web_job_status` if it returns a job id |

`$ARGUMENTS` that is only a URL means `web_scrape`. Anything else starts with `web_search_and_scrape`.

## Search well

- Use a short keyword query, not a sentence. Run a second query with different wording when the first one misses.
- Set `timeRange` (`day`, `week`, `month`, `year`) for anything recent. Set `language` to `ja` for Japanese topics.
- Prefer primary sources (official docs, vendor pages, the original announcement) over summaries of them.
- Fetch fewer pages with a clear purpose rather than many pages "just in case".

## Handle failures

- A single failed URL is not a failed search. Report which URLs could not be read and continue with the rest.
- `loginInProgress`: a manual login is running on the server and fetching is paused. Tell the user and stop retrying.
- `loginRequired`: the saved login for that site has expired. Tell the user to sign in again on the server (`login-session start`); do not guess at the page content.
- Pages that need a login but redirect nowhere may come back as the logged-out view. If member-only content (prices, points, account details) is missing, say so instead of treating the page as complete.

## Answer

1. Lead with the answer.
2. Cite every claim that comes from a page with its URL.
3. Separate what a page says from your own inference, and say when sources disagree.
4. Give dates when freshness matters, and say when a page shows none.
5. State what you could not verify. Never fill a gap with a guess.

Write the answer in the user's language.
