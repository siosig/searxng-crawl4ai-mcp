import * as fs from "node:fs";
import { join } from "node:path";
import { env } from "../utils/env.js";
import { failure, UpstreamError } from "../utils/errors.js";

/**
 * The gate between a manual login and the fetching tools.
 *
 * While an operator is signing in by hand, the browser profile on the session
 * disk is in use and half-written; a crawl started then would either fight the
 * login for the profile or save a state nobody finished. So the login tooling
 * drops a marker file, and every fetch checks for it first.
 */

/** Present (with any content) while a manual login is running. */
export const LOGIN_MARKER_FILE = "login-in-progress";

/** Written once when the session disk is prepared; proves the disk is mounted. */
export const SESSION_ROOT_FILE = ".session-root";

/** True when this deployment keeps logins (LOGIN_STATE_DIR is set). */
export function loginSessionEnabled(): boolean {
  return env().LOGIN_STATE_DIR !== undefined;
}

/**
 * Throws UpstreamError when fetching must not proceed:
 * - LOGIN_STATE_DIR set but SESSION_ROOT_FILE missing in it -> kind "upstreamUnavailable"
 *   (an unmounted disk leaves Docker's empty bind-mount source, so the directory alone proves nothing)
 * - marker file present (any content)                -> kind "loginInProgress"
 * Does nothing when LOGIN_STATE_DIR is unset.
 *
 * Nothing is cached: two stats per call is cheap next to a crawl, and a login
 * that starts must stop the very next fetch.
 */
export function assertNotLoggingIn(): void {
  const dir = env().LOGIN_STATE_DIR;
  if (dir === undefined) return;

  if (!fs.existsSync(join(dir, SESSION_ROOT_FILE))) {
    throw new UpstreamError(
      failure(
        "upstreamUnavailable",
        "The login session store is not available; check that the session disk is mounted.",
      ),
    );
  }
  if (fs.existsSync(join(dir, LOGIN_MARKER_FILE))) {
    throw new UpstreamError(
      failure(
        "loginInProgress",
        'A manual login is in progress on the server, so fetching is paused. Try again after "login-session stop" has finished.',
      ),
    );
  }
}
