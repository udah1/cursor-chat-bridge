import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_DEFAULTS,
  ackEnabledFor,
  ackForMessage,
  ackForStop,
  ackForTranscript,
  detectLanguage,
  normalizeLanguage,
  resolveLanguage,
  resolveStopLanguage,
  truncate,
  type AckConfig,
} from "../src/ack.js";
import type { InboundAttachment, InboundMsg } from "../src/types.js";

const cfg = (over: Partial<AckConfig> = {}): AckConfig => ({ ...ACK_DEFAULTS, enabled: true, ...over });

const msg = (over: Partial<InboundMsg> = {}): InboundMsg => ({ id: "1", text: "hello", ts: 0, ...over });

const att = (kind: InboundAttachment["kind"]): InboundAttachment => ({ kind, filename: `f.${kind}` });

test("ackEnabledFor: off unless explicitly enabled", () => {
  assert.equal(ackEnabledFor(undefined, "discord"), false);
  assert.equal(ackEnabledFor(ACK_DEFAULTS, "discord"), false); // default is opt-in
  assert.equal(ackEnabledFor(cfg(), "discord"), true);
});

test("ackEnabledFor: bot-identity channels only by default (GitHub posts as the user)", () => {
  assert.equal(ackEnabledFor(cfg(), "telegram"), true);
  assert.equal(ackEnabledFor(cfg(), "github"), false);
  assert.equal(ackEnabledFor(cfg({ adapters: ["github"] }), "github"), true);
});

test("detectLanguage: any Hebrew character means Hebrew", () => {
  assert.equal(detectLanguage("תבדוק את זה"), "he");
  assert.equal(detectLanguage("check שוב"), "he"); // mixed still answers in Hebrew
  assert.equal(detectLanguage("check this"), "en");
});

test("detectLanguage: no signal from emoji, digits, or empty text", () => {
  assert.equal(detectLanguage("👍"), null);
  assert.equal(detectLanguage("123 456"), null);
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage(undefined), null);
});

test("normalizeLanguage: accepts both Whisper code and name forms", () => {
  assert.equal(normalizeLanguage("he"), "he");
  assert.equal(normalizeLanguage("hebrew"), "he");
  assert.equal(normalizeLanguage("english"), "en");
  assert.equal(normalizeLanguage("fr"), "en"); // only he/en strings exist
  assert.equal(normalizeLanguage(""), null);
  assert.equal(normalizeLanguage(undefined), null);
});

test("resolveLanguage: an explicit config setting overrides detection", () => {
  assert.equal(resolveLanguage(cfg({ language: "en" }), "he", "he"), "en");
  assert.equal(resolveLanguage(cfg({ language: "he" }), "en", "en"), "he");
});

test("resolveLanguage: auto prefers this message, then the session, then English", () => {
  const auto = cfg({ language: "auto" });
  assert.equal(resolveLanguage(auto, "he", "en"), "he");
  assert.equal(resolveLanguage(auto, null, "he"), "he"); // uncaptioned image after Hebrew chat
  assert.equal(resolveLanguage(auto, null, null), "en");
});

test("resolveStopLanguage: a Hebrew session that types 'Stop' still gets a Hebrew goodbye", () => {
  const auto = cfg({ language: "auto" });
  assert.equal(resolveStopLanguage(auto, "he", detectLanguage("Stop")), "he");
});

test("resolveStopLanguage: without session history the keyword itself decides", () => {
  const auto = cfg({ language: "auto" });
  assert.equal(resolveStopLanguage(auto, null, detectLanguage("עצור")), "he");
  assert.equal(resolveStopLanguage(auto, null, detectLanguage("stop")), "en");
  assert.equal(resolveStopLanguage(auto, null, null), "en");
});

test("resolveStopLanguage: an explicit config setting still wins", () => {
  assert.equal(resolveStopLanguage(cfg({ language: "en" }), "he", "he"), "en");
});

test("ackForMessage: plain text", () => {
  assert.equal(ackForMessage(msg(), false, cfg(), "en"), "Got it, on it…");
  assert.equal(ackForMessage(msg(), false, cfg(), "he"), "קיבלתי, בודק…");
});

test("ackForMessage: image is called out specifically", () => {
  const m = msg({ text: "", attachments: [att("image")] });
  assert.match(ackForMessage(m, false, cfg(), "en")!, /image/);
  assert.match(ackForMessage(m, false, cfg(), "he")!, /תמונה/);
});

test("ackForMessage: audio promises a transcript only when STT is on", () => {
  const m = msg({ text: "", attachments: [att("audio")] });
  assert.match(ackForMessage(m, true, cfg(), "en")!, /transcribing/);
  assert.match(ackForMessage(m, false, cfg(), "en")!, /transcription is off/);
});

test("ackForMessage: audio wins over a co-attached image (the transcript drives the reply)", () => {
  const m = msg({ attachments: [att("image"), att("audio")] });
  assert.match(ackForMessage(m, true, cfg(), "en")!, /voice/);
});

test("ackForMessage: video and other files share the generic file note", () => {
  assert.match(ackForMessage(msg({ attachments: [att("video")] }), false, cfg(), "en")!, /file/);
  assert.match(ackForMessage(msg({ attachments: [att("file")] }), false, cfg(), "en")!, /file/);
});

test("ackForMessage: daemon-injected transcripts are never acked (no triple reply)", () => {
  assert.equal(ackForMessage(msg({ synthetic: true }), true, cfg(), "en"), null);
});

test("ackForTranscript: echoes the transcript", () => {
  assert.equal(ackForTranscript("build the thing", cfg(), "en"), "Got your request: “build the thing”");
});

test("ackForTranscript: collapses whitespace and truncates long transcripts", () => {
  assert.match(ackForTranscript("a\n\n  b   c", cfg(), "en"), /“a b c”/);
  assert.match(ackForTranscript("x".repeat(300), cfg({ maxTranscriptChars: 10 }), "en"), /“x{9}…”/);
});

test("ackForTranscript: falls back to a plain note when echoing is off", () => {
  const out = ackForTranscript("secret plan", cfg({ echoTranscript: false }), "en");
  assert.equal(out, "Got your request, on it…");
  assert.ok(!out.includes("secret plan"));
});

test("ackForTranscript: an empty transcript never renders empty quotes", () => {
  assert.equal(ackForTranscript("   ", cfg(), "en"), "Got your request, on it…");
});

test("truncate: leaves short strings untouched", () => {
  assert.equal(truncate("short", 200), "short");
});

test("ackForStop: reports the session ended", () => {
  assert.match(ackForStop("en"), /stopped/i);
  assert.match(ackForStop("he"), /נעצרה/);
});
