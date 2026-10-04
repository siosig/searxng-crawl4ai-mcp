"""Make every browser this Crawl4AI server starts open the saved login profile.

Crawl4AI 0.9 refuses `user_data_dir`, `cookies` and `storage_state` when they
arrive over the network, and its /crawl routes never read the browser settings
in config.yml. The one place every route passes its effective BrowserConfig
through, right before taking a browser from the pool, is
`egress_broker.enforce_egress` - so the Dockerfile wraps that function with
`wrap()` below. See specs/006-persistent-login-sessions/research.md R1 and R2.

The wrapper does not add the profile to whatever config it is given. It
replaces the whole config with one canonical shape. Chromium lets only one
process open a profile, and the pool keys browsers by a hash of the config:
the /crawl routes send library defaults while /llm/{url} builds its config
from config.yml, so two shapes would mean two browsers fighting over one
profile. One shape means one pooled browser.
"""

import copy
import os
from typing import Callable


def wrap(enforce: Callable[[object], None]) -> Callable[[object], None]:
    # Read here rather than at import, so the decision is made once, when the
    # server module that owns enforce_egress is loaded with its environment.
    profile = os.environ.get("C4AI_SESSION_PROFILE_DIR", "").strip()
    if not profile:
        # Login sessions are off: behave exactly like the unmodified image.
        return enforce

    def enforce_with_session(browser_config):
        if browser_config is None:
            return enforce(browser_config)

        canonical = type(browser_config)()
        canonical.use_persistent_context = True
        # The constructor turns this on for a persistent context; set it the
        # same way here because the attribute is assigned after construction.
        canonical.use_managed_browser = True
        canonical.user_data_dir = profile
        # Egress hardening (pinning proxy, TLS verification) applies to the
        # canonical shape, so the profile never weakens it.
        enforce(canonical)

        state = vars(browser_config)
        state.clear()
        state.update(copy.deepcopy(vars(canonical)))

    enforce_with_session.__wrapped__ = enforce
    return enforce_with_session
