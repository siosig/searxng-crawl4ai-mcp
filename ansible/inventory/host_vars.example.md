# Host variables

`host_vars/<host>/vars.yml` and `host_vars/<host>/vault.yml` live here and are
gitignored: they name a real machine and hold its credentials.

`vars.yml`:

```yaml
mcp_deploy_dir: /opt/searxng-crawl4ai-mcp
mcp_port: 3003
mcp_public_hostname: mcp.example.com
mcp_max_concurrent_fetches: 2   # lower than the default on a low-power host
```

`vault.yml` (encrypt with `ansible-vault encrypt`):

```yaml
vault_mcp_auth_token: "..."
vault_searxng_secret: "..."
vault_crawl4ai_api_token: "..."
vault_proxy_url: ""
```

The Gemini API key is not kept here. It is read at deploy time from the `.env`
file at the repository root, which is gitignored.
