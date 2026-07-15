import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Isolate runtime state under a temp HOME before importing modules that read it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
process.env.HOME = tmpHome;

const { Store } = await import("../src/state.js");

test("Store: own-message filtering", () => {
  const s = new Store();
  s.upsert("s1", { title: "t", cwd: "/x", adapter: "github" });
  s.recordOwnMessage("s1", "m-100");
  assert.equal(s.isOwnMessage("s1", "m-100"), true);
  assert.equal(s.isOwnMessage("s1", "m-999"), false);
});

test("Store: inbox dedupe + drop own", () => {
  const s = new Store();
  s.upsert("s2", { title: "t", cwd: "/x", adapter: "telegram" });
  s.recordOwnMessage("s2", "own");
  s.enqueueInbound("s2", { id: "own", text: "echo", ts: 1 }); // dropped (own)
  s.enqueueInbound("s2", { id: "u1", text: "hello", ts: 2 });
  s.enqueueInbound("s2", { id: "u1", text: "hello dup", ts: 3 }); // dropped (dup id)
  const drained = s.drainInbox("s2");
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, "hello");
  assert.equal(s.drainInbox("s2").length, 0);
});

test("Store: requestStop bumps generation and deactivates", () => {
  const s = new Store();
  const rec = s.upsert("s3", { title: "t", cwd: "/x", adapter: "github" });
  const gen0 = rec.generation;
  s.requestStop("s3");
  const after = s.get("s3")!;
  assert.equal(after.active, false);
  assert.equal(after.stopRequested, true);
  assert.equal(after.generation, gen0 + 1);
});

test("Store: persists across instances", () => {
  const s = new Store();
  s.upsert("s4", { title: "persist", cwd: "/y", adapter: "github" });
  s.recordOwnMessage("s4", "keep");
  const s2 = new Store();
  assert.equal(s2.get("s4")?.title, "persist");
  assert.equal(s2.isOwnMessage("s4", "keep"), true);
});
