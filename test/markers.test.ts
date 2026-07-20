import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Isolate runtime state under a temp HOME before importing modules that read it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-markers-"));
process.env.HOME = tmpHome;

const markers = await import("../src/markers.js");
const { MARKERS_DIR } = await import("../src/paths.js");

const PENDING = path.join(MARKERS_DIR, "pending");
const CONV = path.join(MARKERS_DIR, "conv");
const CLAIMING = path.join(MARKERS_DIR, "claiming");
const FRESH = 600000;

function reset(): void {
  for (const d of [PENDING, CONV, CLAIMING, path.join(MARKERS_DIR, "ws")]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

function activeMarker(id: string): void {
  markers.writeMarker({
    conversationId: id,
    sessionId: id,
    adapter: "github",
    thread: "t1",
    workspace: "/tmp/ws",
    active: true,
    updatedAt: Date.now(),
  });
}

test("claim: exactly one fresh pending -> claimed and moved to claiming/", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-A", "/tmp/wsA", now);
  const r = markers.claimStartConversation(now, FRESH);
  assert.ok(!("none" in r));
  if (!("none" in r)) {
    assert.equal(r.conversationId, "conv-A");
    assert.equal(r.workspace, "/tmp/wsA");
  }
  assert.equal(fs.existsSync(path.join(PENDING, "conv-A.json")), false, "pending consumed");
  assert.equal(fs.existsSync(path.join(CLAIMING, "conv-A.json")), true, "moved to claiming");
  // Never mints a conv marker.
  assert.equal(fs.existsSync(path.join(CONV, "conv-A.json")), false, "no conv marker minted by claim");
});

test("claim: zero pending -> none:empty (caller may try legacy fallback)", () => {
  reset();
  const r = markers.claimStartConversation(Date.now(), FRESH);
  assert.deepEqual(r, { none: "empty" });
});

test("claim: multiple fresh pending (no workspace) -> none:ambiguous, nothing consumed", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-X", "/tmp/x", now);
  markers.writePending("conv-Y", "/tmp/y", now);
  const r = markers.claimStartConversation(now, FRESH);
  assert.deepEqual(r, { none: "ambiguous" });
  assert.equal(fs.existsSync(path.join(PENDING, "conv-X.json")), true, "X not consumed");
  assert.equal(fs.existsSync(path.join(PENDING, "conv-Y.json")), true, "Y not consumed");
});

test("claim: workspace scoping picks the pending for THIS workspace (multi-window)", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-here", "/tmp/here", now);
  markers.writePending("conv-other1", "/tmp/other1", now);
  markers.writePending("conv-other2", "/tmp/other2", now);
  const r = markers.claimStartConversation(now, FRESH, "/tmp/here");
  assert.ok(!("none" in r), "resolves despite other windows' fresh pendings");
  if (!("none" in r)) assert.equal(r.conversationId, "conv-here");
  // Other windows' pendings are untouched.
  assert.equal(fs.existsSync(path.join(PENDING, "conv-other1.json")), true);
  assert.equal(fs.existsSync(path.join(PENDING, "conv-other2.json")), true);
});

test("claim: two pendings in the SAME workspace -> none:ambiguous", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-P", "/tmp/same", now);
  markers.writePending("conv-Q", "/tmp/same", now);
  const r = markers.claimStartConversation(now, FRESH, "/tmp/same");
  assert.deepEqual(r, { none: "ambiguous" });
});

test("claim: no workspace match falls back to a single global pending (cwd/none edge)", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-only", "/tmp/realfolder", now);
  const r = markers.claimStartConversation(now, FRESH, "/some/mismatched/cwd");
  assert.ok(!("none" in r));
  if (!("none" in r)) assert.equal(r.conversationId, "conv-only");
});

test("claim: only stale pending -> none:stale and stale pruned", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-old", "/tmp/o", now - FRESH - 1000);
  const r = markers.claimStartConversation(now, FRESH);
  assert.deepEqual(r, { none: "stale" });
  assert.equal(fs.existsSync(path.join(PENDING, "conv-old.json")), false, "stale pruned");
});

test("claim: pending with an already-active marker is excluded -> none:stale", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-active", "/tmp/a", now);
  activeMarker("conv-active");
  const r = markers.claimStartConversation(now, FRESH);
  assert.deepEqual(r, { none: "stale" });
});

test("claim: onboarding-style repeat does not double-consume (finalize commits)", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-F", "/tmp/f", now);
  const r1 = markers.claimStartConversation(now, FRESH);
  assert.ok(!("none" in r1));
  markers.finalizeClaim("conv-F");
  assert.equal(fs.existsSync(path.join(CLAIMING, "conv-F.json")), false, "claim finalized");
  // A second claim finds nothing fresh (already consumed) -> empty.
  const r2 = markers.claimStartConversation(now, FRESH);
  assert.deepEqual(r2, { none: "empty" });
});

test("restoreClaim: register failure returns pending so a retry can claim again", () => {
  reset();
  const now = Date.now();
  markers.writePending("conv-R", "/tmp/r", now);
  const r1 = markers.claimStartConversation(now, FRESH);
  assert.ok(!("none" in r1));
  markers.restoreClaim("conv-R");
  assert.equal(fs.existsSync(path.join(PENDING, "conv-R.json")), true, "pending restored");
  assert.equal(fs.existsSync(path.join(CLAIMING, "conv-R.json")), false, "claiming cleared");
  const r2 = markers.claimStartConversation(now, FRESH);
  assert.ok(!("none" in r2));
  if (!("none" in r2)) assert.equal(r2.conversationId, "conv-R");
});

test("resolveActiveConversation: explicit only, requires a marker", () => {
  reset();
  assert.equal(markers.resolveActiveConversation(undefined), null, "no session -> null");
  assert.equal(markers.resolveActiveConversation("nope"), null, "unknown session -> null");
  activeMarker("conv-S");
  assert.equal(markers.resolveActiveConversation("conv-S"), "conv-S", "known session -> id");
});

test("legacyResolve: fresh ws pointer wins; stale -> null (never mints)", () => {
  reset();
  const now = Date.now();
  const ws = "/tmp/legacy";
  const wsFile = path.join(MARKERS_DIR, "ws", `${markers.wsHash(ws)}.json`);
  fs.mkdirSync(path.dirname(wsFile), { recursive: true });
  fs.writeFileSync(wsFile, JSON.stringify({ conversationId: "conv-L", at: now }));
  const r = markers.legacyResolve(now, FRESH, ws);
  assert.deepEqual(r, { conversationId: "conv-L", workspace: ws });

  fs.writeFileSync(wsFile, JSON.stringify({ conversationId: "conv-L", at: now - FRESH - 1 }));
  assert.equal(markers.legacyResolve(now, FRESH, ws), null, "stale ws pointer -> null");
});
