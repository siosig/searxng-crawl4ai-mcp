#!/usr/bin/env bash
# Start Crawl4AI on the saved login profile, or refuse to start at all.
#
# Refusing is the point: an unmounted session disk leaves Docker's empty
# bind-mount source behind, and a crawler that started on it would quietly
# fetch everything logged out. See specs/006-persistent-login-sessions
# (research.md R5 and R7) for the exclusivity rules this enforces.
set -euo pipefail

if [[ -z "${C4AI_SESSION_ROOT:-}" ]]; then
    # Logins are not configured here: run exactly like the upstream image.
    cd /app && exec bash /app/entrypoint.sh
fi

if [[ ! -e "$C4AI_SESSION_ROOT/state/.session-root" ]]; then
    echo "c4ai-session: $C4AI_SESSION_ROOT/state/.session-root is missing; the session disk is not mounted or not prepared. Refusing to start without the saved logins." >&2
    exit 1
fi

marker="$C4AI_SESSION_ROOT/state/login-in-progress"
if [[ -e "$marker" ]]; then
    state="$(tr -d '[:space:]' < "$marker")"
    # "resuming" is written once the login browser has let go of the profile;
    # anything else means it may still hold it.
    if [[ "$state" != "resuming" ]]; then
        echo "c4ai-session: a manual login is in progress (state: $state); waiting for \"login-session stop\"." >&2
        exit 1
    fi
fi

profile="$C4AI_SESSION_ROOT/profile"
[[ -d "$profile" ]] || mkdir -m 0700 "$profile"

# A recreated container has a new hostname, and Chromium reads a lock left by
# the old one as "in use by another computer". Clearing it is safe only
# because the marker check above guarantees no other browser holds the profile.
rm -f "$profile"/Singleton{Lock,Socket,Cookie}

export C4AI_SESSION_PROFILE_DIR="$profile"
cd /app && exec bash /app/entrypoint.sh
