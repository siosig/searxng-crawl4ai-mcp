#!/usr/bin/env bash
# Restart the crawl4ai container when its browser stops answering.
#
# The container's own healthcheck only asks /health, which stays green while the
# pooled browser is dead (a cgroup OOM kills chrome, not the API server), and
# Docker never restarts an unhealthy container anyway. This renders a page from
# an inline document - no network, so a flaky site cannot fail it - and
# restarts after WATCHDOG_THRESHOLD consecutive failures. The saved logins live
# on the session disk, so a restart loses nothing.
#
# With WATCHDOG_MODE=scheduled it instead restarts once a day, and only while
# nobody is using the browser: the pooled login-profile browser is never
# recycled by Crawl4AI and grows for as long as it lives.
#
# Configuration comes from the unit's Environment=, so one file serves tests.
set -u

container="${WATCHDOG_CONTAINER:?WATCHDOG_CONTAINER is required}"
threshold="${WATCHDOG_THRESHOLD:-3}"
state_dir="${WATCHDOG_STATE_DIR:-/run/crawl4ai-watchdog}"
login_marker="${WATCHDOG_LOGIN_MARKER:-}"
marker_text="probe-ok-7431"
mode="${WATCHDOG_MODE:-probe}"
min_interval_sec="${WATCHDOG_MIN_INTERVAL_SEC:-72000}"
idle_window="${WATCHDOG_IDLE_WINDOW:-10m}"

log() { logger -t crawl4ai-watchdog -- "$*"; echo "$*"; }

mkdir -p "$state_dir"
counter="$state_dir/$container.fails"
reset() { rm -f "$counter"; }

# Not running means someone stopped it on purpose (login-session does); never
# start it from here.
running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)"
if [[ "$running" != "true" ]]; then reset; exit 0; fi

# A manual login is in progress or about to resume: leave the profile alone.
if [[ -n "$login_marker" && -e "$login_marker" ]]; then reset; exit 0; fi

if [[ "$mode" == "scheduled" ]]; then
    stamp="$state_dir/$container.last-scheduled"
    now="$(date +%s)"
    last="$(cat "$stamp" 2>/dev/null || echo 0)"
    if (( now - last < min_interval_sec )); then exit 0; fi
    # Every finished fetch logs a [FETCH] line; the probe's own are "Raw HTML".
    busy="$(docker logs --since "$idle_window" "$container" 2>&1 | grep -F '[FETCH]' | grep -vc 'Raw HTML')"
    if (( busy > 0 )); then
        log "scheduled restart deferred: $busy fetches in the last $idle_window"
        exit 0
    fi
    log "scheduled restart of $container (idle for $idle_window)"
    docker restart "$container" >/dev/null && echo "$now" > "$stamp"
    exit 0
fi

health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
if [[ "$health" == "starting" ]]; then exit 0; fi

# The token is expanded inside the container, so it never reaches this host's
# process list or the journal.
probe='curl -s -m 45 -X POST http://localhost:11235/crawl -H "Authorization: Bearer $CRAWL4AI_API_TOKEN" -H "Content-Type: application/json" -d "{\"urls\":[\"raw:<html><body><p>'"$marker_text"'</p></body></html>\"]}"'
out="$(timeout 60 docker exec "$container" sh -c "$probe" 2>&1)"
rc=$?

if [[ $rc -eq 0 && "$out" == *"$marker_text"* ]] && grep -Eq '"success": ?true' <<<"$out"; then
    reset
    exit 0
fi

fails=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$counter"
log "probe failed ($fails/$threshold) container=$container rc=$rc"
if (( fails >= threshold )); then
    log "restarting $container after $fails consecutive probe failures"
    docker restart "$container" >/dev/null && reset
fi
exit 0
