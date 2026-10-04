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

## Logged-in fetching (optional)

Some pages show their real content only to a signed-in member. Instead of
storing site credentials in configuration, crawl4ai can run its browser on one
saved profile: you sign in to a site once, by hand, in a Google Chrome window
that the host opens on that profile, and every later fetch carries that login.
Any number of sites can be added this way without a configuration change. A
fetch that a site redirects to its login page fails with `loginRequired`, so an
expired login is visible instead of silently returning the public page.

### Enabling it

Set these in the host's `host_vars` (see
[ansible/inventory/host_vars.example.md](ansible/inventory/host_vars.example.md));
leaving `mcp_login_session_root` empty keeps the feature off.

- `mcp_login_session_mountpoint` - the disk that holds the store.
- `mcp_login_session_root` - the store itself, under the mount point. It holds
  `profile/` (the browser profile) and `state/`.
- `mcp_login_user` - the host user that runs the login browser; the user whose
  desktop shows it. Required when
  `mcp_login_session_root` is set.
- `mcp_login_display` (`:1`) and `mcp_login_browser` (`/usr/bin/google-chrome`)
  - the X display to open the browser on, and the browser. The defaults fit
  a host with a single desktop on `:1`.

The host must already have Google Chrome and a way to show a browser on that
display - a VNC desktop, a monitor, whichever it has. `login-session` only
starts the browser there; it never starts or stops the display. This
repository does not install or change either of them.
The Ansible role creates the store only after checking that the disk is
mounted, so an unmounted disk is never mistaken for an empty store. The store's
root is mode 0711, so the login user can reach `profile/` without being able to
list the store.

### Signing in

```sh
sudo <deploy dir>/login-session start    # pauses fetching, opens the login browser
# open the host's desktop and sign in (below)
sudo <deploy dir>/login-session stop     # saves the login, resumes fetching
sudo <deploy dir>/login-session status   # shows the marker, the login browser,
                                         # crawl4ai and the profile owner
```

For example, on a host whose desktop is a VNC server listening on a unix
socket:

1. `ssh <host> sudo /opt/searxng-crawl4ai-mcp/login-session start`
2. Open the host's desktop on display `:1` by whatever means the host offers.
   Today that is its VNC desktop: keep a tunnel open with
   `ssh -N -L 5901:/run/vnc-desktop/vnc.sock <login user>@<host>`
3. ...and connect a VNC client to `localhost:5901`. There is no VNC password;
   SSH is the gate.
4. Sign in in the Chrome window that `start` opened (a blank tab). The
   desktop's autostart also opens a Chrome on the default profile; do not
   confuse the two. Open `chrome://version` and use the window whose "Profile
   Path" is `<store>/profile/Default`.
5. `ssh <host> sudo /opt/searxng-crawl4ai-mcp/login-session stop`. It prints
   `Login saved. Fetching has resumed.`; the VNC client and the tunnel can then
   be closed.

`start` refuses to run when the host's Chrome and the crawler's Chromium have
different major versions, because both write to the same profile and a newer
major version can change its on-disk format. It prints both versions. Either
update `CRAWL4AI_SESSION_IMAGE` to a build with the same major version as the
host's Chrome, or hold the host's Chrome until the crawler catches up
(`sudo apt-mark hold google-chrome-stable`).

`start` stops crawl4ai first because a Chromium profile can be opened by only
one browser at a time. On each site, tick "keep me signed in" (or its
equivalent): without it many sites issue a session cookie with no expiry,
which the browser does not save when it closes, so the login would not survive
`stop`.

To remove one site's login and keep the others, run `start`, open
`chrome://settings/content/all` in the login browser, delete that site's data
(or sign out on the site), then run `stop`.

### While a login is in progress

Between `start` and the end of `stop`, fetches fail with `loginInProgress`
rather than looking like an outage. Do not deploy during that time: crawl4ai
refuses to start while a login is in progress, so the deployment's
`up --wait` cannot complete.

### Limitations

- A site that shows its login form inside the member page, instead of
  redirecting to a login page, cannot be detected as logged out.
- `web_extract` uses the login but does not detect an expired one, because it
  does not return the final URL.
- Other clients that use crawl4ai directly through the host's port 11235 (such
  as mcp-ec) get the same login, and the `browser_config` they send is ignored.
- During a login, those direct clients cannot reach crawl4ai either.
- While pages are fetched, the profile is owned by uid/gid 999, which may be
  an unrelated host user (such as `dnsmasq`); that user can read the profile too (see Security).
- When apt upgrades the host's Google Chrome to a new major version,
  `login-session start` stops at the version check. Update
  `CRAWL4AI_SESSION_IMAGE` to match, or `sudo apt-mark hold google-chrome-stable`.

### Security

- This feature opens no new network listener. The login browser appears on
  the host's existing VNC desktop, which listens only on a Unix socket that
  only its owner can open (mode 0600, no TCP). Reaching it requires SSH as that
  user, so SSH is the gate, and the VNC traffic stays inside the SSH tunnel.
- The login browser runs with `--password-store=basic`. The VNC session runs a
  keyring, and without this flag Chrome encrypts cookies with the keyring's
  key, which the crawler's Chromium does not have, so the crawler could not
  read the login. With it, cookies are encrypted with Chromium's fixed
  built-in key, so the profile is protected only by its file permissions.
  You can check which key was used: the first three bytes of
  `encrypted_value` in `<store>/profile/Default/Cookies` are `v10` for the
  fixed key and `v11` for a keyring key.
- While pages are fetched, the profile belongs to uid/gid 999 (the crawl4ai
  container's user). If uid 999 is an existing host user (such as `dnsmasq`), that
  user's processes can read the profile, cookies included. This risk is accepted: changing the
  container's uid would mean re-owning every directory the upstream image
  writes to.
- The login applies to every URL this server fetches. Anyone who can call the
  MCP endpoint can read pages as the signed-in member, so sign in only to
  accounts whose pages you are prepared to expose to those callers.

### Recovery

- If the host reboots during a login, the login browser is gone, crawl4ai
  stays stopped and the marker stays at `login`, so fetches keep failing with
  `loginInProgress`. Run `login-session stop` to recover: it returns the
  profile to the crawler and starts crawl4ai. `login-session status` shows the
  state first.
- Rolling `CRAWL4AI_SESSION_IMAGE` back to an older build can leave a profile
  that the older Chromium cannot open, because a newer Chromium has already
  written to it. Empty `profile/` and sign in again. Only upgrades are covered
  by the guarantee that logins survive an image update.

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
