# Host variables

`host_vars/<host>/vars.yml` and `host_vars/<host>/vault.yml` live here and are
gitignored: they name a real machine and hold its credentials.

`vars.yml`:

```yaml
mcp_deploy_dir: /opt/searxng-crawl4ai-mcp
mcp_port: 3003
mcp_public_hostname: mcp.example.com
mcp_max_concurrent_fetches: 2   # lower than the default on a low-power host

# Optional. Leave both unset (or empty) unless another service on this same
# host needs to call searxng or crawl4ai directly - see
# docker/compose.local-services.yaml for what turning them on gives up.
mcp_local_searxng_port: 8081
mcp_local_crawl4ai_port: 11235

# Optional. Keep manual logins (specs/006-persistent-login-sessions): every
# fetch uses one saved browser profile, and `login-session start|stop` on the
# host opens that profile in the host's own Chrome, on its existing VNC
# desktop, to sign in with. Leave the root unset to turn the feature off. The role creates the store under the mount point only after
# checking that the disk is mounted, so an unmounted disk cannot be mistaken
# for an empty store.
mcp_login_session_mountpoint: /mnt/<data-disk>
mcp_login_session_root: /mnt/<data-disk>/searxng-crawl4ai-mcp/login-session
mcp_login_user: <desktop-user>   # the login browser runs as this user, on their desktop
# mcp_login_display (":1") and mcp_login_browser ("/usr/bin/google-chrome")
# have defaults. The host must already be able to show a browser on that
# display (a VNC desktop or a monitor); login-session does not manage it.
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
