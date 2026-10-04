import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  LOGIN_MARKER_FILE,
  SESSION_ROOT_FILE,
  assertNotLoggingIn,
  loginSessionEnabled,
} from "../../src/upstream/login-session.js";
import { setEnvForTest, type Env } from "../../src/utils/env.js";
import { UpstreamError, type ToolFailure } from "../../src/utils/errors.js";

/**
 * The gate that pauses fetching while someone is signing in by hand.
 *
 * It reads the disk on every call, so each case builds the directory it needs
 * and points the configuration at it. Nothing is cached between cases.
 */

const UNAVAILABLE =
  "The login session store is not available; check that the session disk is mounted.";
const LOGGING_IN =
  'A manual login is in progress on the server, so fetching is paused. Try again after "login-session stop" has finished.';

/** A fresh directory, removed again when the test ends. */
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(os.tmpdir() + "/c4ai-login-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Point LOGIN_STATE_DIR at `dir` (or leave it unset) for the rest of the test. */
function useLoginStateDir(t: TestContext, dir: string | undefined): void {
  setEnvForTest({ LOGIN_STATE_DIR: dir } as unknown as Env);
  // The module caches whatever was installed last; leaving it behind would let
  // a later test in this process read this one's configuration.
  t.after(() => setEnvForTest(null));
}

/** A directory that looks like a mounted session disk. */
function mountedStore(t: TestContext): string {
  const dir = tempDir(t);
  fs.writeFileSync(join(dir, SESSION_ROOT_FILE), "");
  return dir;
}

/** The failure `assertNotLoggingIn` threw, or a test failure if it did not throw. */
function thrownFailure(): ToolFailure {
  try {
    assertNotLoggingIn();
  } catch (error) {
    assert.ok(error instanceof UpstreamError, `expected UpstreamError, got ${String(error)}`);
    return error.failure;
  }
  assert.fail("assertNotLoggingIn() did not throw");
}

test("(1) with LOGIN_STATE_DIR unset the gate is off and never throws", (t) => {
  useLoginStateDir(t, undefined);

  assert.doesNotThrow(() => assertNotLoggingIn());
  assert.equal(loginSessionEnabled(), false);
});

test("(2) a mounted store with no marker lets fetching through", (t) => {
  useLoginStateDir(t, mountedStore(t));

  assert.doesNotThrow(() => assertNotLoggingIn());
  assert.equal(loginSessionEnabled(), true);
});

test("(3) a login marker pauses fetching", (t) => {
  const dir = mountedStore(t);
  useLoginStateDir(t, dir);
  fs.writeFileSync(join(dir, LOGIN_MARKER_FILE), "login");

  const f = thrownFailure();
  assert.equal(f.kind, "loginInProgress");
  assert.equal(f.upstreamStatus, null);
});

test("(4) the marker's content does not matter: 'resuming' pauses as well", (t) => {
  const dir = mountedStore(t);
  useLoginStateDir(t, dir);
  fs.writeFileSync(join(dir, LOGIN_MARKER_FILE), "resuming");

  const f = thrownFailure();
  assert.equal(f.kind, "loginInProgress");
  assert.equal(f.upstreamStatus, null);
});

test("(5) a directory that does not exist reports the store as unavailable", (t) => {
  useLoginStateDir(t, join(tempDir(t), "does-not-exist"));

  const f = thrownFailure();
  assert.equal(f.kind, "upstreamUnavailable");
  assert.equal(f.upstreamStatus, null);
});

test("(5b) a directory without the session-root file is unavailable, marker or not", (t) => {
  // An unmounted disk leaves Docker's empty bind-mount source behind, so the
  // directory existing proves nothing on its own.
  const dir = tempDir(t);
  useLoginStateDir(t, dir);

  assert.equal(thrownFailure().kind, "upstreamUnavailable");

  fs.writeFileSync(join(dir, LOGIN_MARKER_FILE), "login");
  assert.equal(
    thrownFailure().kind,
    "upstreamUnavailable",
    "a missing store must win over the marker: it is the more fundamental fault",
  );
});

test("(6) the messages are the fixed sentences from the contract", (t) => {
  const missing = tempDir(t);
  useLoginStateDir(t, missing);
  assert.equal(thrownFailure().message, UNAVAILABLE);

  const dir = mountedStore(t);
  setEnvForTest({ LOGIN_STATE_DIR: dir } as unknown as Env);
  fs.writeFileSync(join(dir, LOGIN_MARKER_FILE), "login");
  assert.equal(thrownFailure().message, LOGGING_IN);
});
