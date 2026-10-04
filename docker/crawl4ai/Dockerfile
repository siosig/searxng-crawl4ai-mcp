# syntax=docker/dockerfile:1
#
# Crawl4AI with the saved login profile (specs/006-persistent-login-sessions).
#
# The smallest change that lets the crawler use logins: Crawl4AI 0.9 refuses a
# browser profile sent over the network, so the server itself is taught to open
# one. The manual login happens in the host's own Chrome on the same profile;
# this image only records which Chromium it carries so the host can check the
# two match. The upstream version still comes from versions.env, passed in by CI.
ARG CRAWL4AI_IMAGE
FROM ${CRAWL4AI_IMAGE}

USER root

COPY session_profile.py /app/session_profile.py
COPY --chmod=0755 crawl4ai-entrypoint.sh /opt/c4ai-session/

# Appended rather than edited in place: a few lines at the end survive upstream
# changes to the module body, and the self-test below fails the build if the
# function they wrap ever goes away.
RUN printf '\n%s\n%s\n%s\n' \
      '# searxng-crawl4ai-mcp (specs/006): open the saved login profile on every browser this server starts.' \
      'import session_profile as _c4ai_session_profile' \
      'enforce_egress = _c4ai_session_profile.wrap(enforce_egress)' \
      >> /app/egress_broker.py

USER appuser

# Every route shape must collapse to one canonical config, or two pooled
# browsers would try to open the same profile.
RUN cd /app && C4AI_SESSION_PROFILE_DIR=/tmp/c4ai-selftest python - <<'EOF'
import egress_broker
from crawl4ai import BrowserConfig

a = BrowserConfig(text_mode=True)
b = BrowserConfig()
egress_broker.enforce_egress(a)
egress_broker.enforce_egress(b)
assert a.to_dict() == b.to_dict(), "configs from different routes must be identical"
assert a.use_persistent_context is True
assert a.use_managed_browser is True
assert a.user_data_dir == "/tmp/c4ai-selftest"
assert a.text_mode is False
print("session profile self-test: enabled shape ok")
EOF

# With the variable unset the wrapper must be a no-op.
RUN cd /app && C4AI_SESSION_PROFILE_DIR= python - <<'EOF'
import egress_broker
from crawl4ai import BrowserConfig

c = BrowserConfig(text_mode=True)
egress_broker.enforce_egress(c)
assert c.text_mode is True
assert c.use_persistent_context is False
print("session profile self-test: disabled is a no-op")
EOF

# What `login-session start` on the host reads before opening the profile in
# the host's Chrome: the two browsers must share a major version, or the newer
# one's cookie database is unreadable to the older. The user agent lets the
# login browser present itself the way the crawler will later.
RUN cd /app && python - <<'EOF'
import subprocess
from playwright.sync_api import sync_playwright
from crawl4ai import BrowserConfig

with sync_playwright() as p:
    chrome = p.chromium.executable_path
version = subprocess.run([chrome, "--version"], capture_output=True, text=True, check=True).stdout.strip()
agent = (BrowserConfig().user_agent or "").strip()
assert version and agent, "could not read the bundled Chromium version or user agent"
with open("/tmp/chromium-version", "w") as f:
    f.write(version + "\n")
with open("/tmp/user-agent", "w") as f:
    f.write(agent + "\n")
print("baked:", version, "|", agent)
EOF

USER root
RUN install -m 0644 /tmp/chromium-version /tmp/user-agent /opt/c4ai-session/ \
 && rm -f /tmp/chromium-version /tmp/user-agent
USER appuser

CMD ["bash", "/opt/c4ai-session/crawl4ai-entrypoint.sh"]
