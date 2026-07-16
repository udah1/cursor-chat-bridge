import { test } from "node:test";
import assert from "node:assert/strict";
import { createSttProvider, sanitizeSttError, withTimeout, STT_DEFAULTS, type SttConfig } from "../src/stt.js";
import { isStop, stripAudioNotes } from "../src/daemon.js";

const cfg = (over: Partial<SttConfig>): SttConfig => ({ ...STT_DEFAULTS, ...over });

test("createSttProvider: null when disabled", () => {
  assert.equal(createSttProvider(cfg({ enabled: false })), null);
});

test("createSttProvider: null for openai without a key", () => {
  assert.equal(createSttProvider(cfg({ enabled: true, provider: "openai", apiKey: "" })), null);
});

test("createSttProvider: builds a local provider", () => {
  const p = createSttProvider(cfg({ enabled: true, provider: "local", localBin: "echo" }));
  assert.ok(p);
  assert.equal(p?.name, "local");
});

test("LocalSttProvider: substitutes {file} and captures stdout", async () => {
  const p = createSttProvider(cfg({ enabled: true, provider: "local", localBin: "echo", localArgs: ["{file}"] }))!;
  const res = await p.transcribe("/tmp/sample.ogg", { language: "auto" });
  assert.equal(res.text, "/tmp/sample.ogg");
});

test("LocalSttProvider: missing binary rejects with a clear message", async () => {
  const p = createSttProvider(cfg({ enabled: true, provider: "local", localBin: "definitely-not-a-real-bin-xyz" }))!;
  await assert.rejects(() => p.transcribe("/tmp/x.ogg", {}), /not found/);
});

test("withTimeout: rejects when the inner promise is too slow", async () => {
  await assert.rejects(() => withTimeout(new Promise((r) => setTimeout(r, 200)), 20, "stt"), /timed out/);
});

test("sanitizeSttError: redacts token-like strings and truncates", () => {
  const out = sanitizeSttError(new Error("bad key sk-ABCDEF1234567890 rejected"));
  assert.ok(!out.includes("sk-ABCDEF1234567890"));
  assert.ok(out.includes("[redacted]"));
});

test("stop-keyword safety: a transcribed 'stop' does NOT trigger isStop", () => {
  assert.equal(isStop("stop"), true); // typed stop still ends the session
  assert.equal(isStop("עצור"), true);
  assert.equal(isStop("[voice transcript (he)]: stop"), false); // transcribed stop does not
  assert.equal(isStop("[voice transcript (en)]: please stop the build"), false);
});

test("stripAudioNotes: removes bracketed audio attachment notes, keeps real text", () => {
  const input = "here is my caption\n[audio attachment \"v.ogg\" received — saved locally at: /x/v.ogg]";
  assert.equal(stripAudioNotes(input), "here is my caption");
  // A transcript note (does not end with ']') is left intact — it's appended after stripping.
  assert.equal(stripAudioNotes("[voice transcript (he)]: hi"), "[voice transcript (he)]: hi");
});
