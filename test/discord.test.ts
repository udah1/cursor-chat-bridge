import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMessages, type DiscordMessage } from "../src/adapters/discord.js";

const msg = (id: string, authorId: string, content: string, bot = false): DiscordMessage => ({
  id,
  content,
  timestamp: "2026-01-01T00:00:00.000Z",
  author: { id: authorId, bot },
});

test("filterMessages: first poll establishes baseline only (no replay)", () => {
  const raw = [msg("200", "7", "hi"), msg("199", "app", "intro", true)];
  const { messages, cursor } = filterMessages(raw, null, "app", new Set());
  assert.equal(messages.length, 0); // baseline: nothing replayed
  assert.equal(cursor, "200"); // advanced to max snowflake
});

test("filterMessages: returns user messages, drops bot/own posts", () => {
  const raw = [msg("300", "7", "steer me"), msg("301", "app", "agent reply", true)];
  const { messages, cursor } = filterMessages(raw, "200", "app", new Set());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "steer me");
  assert.equal(messages[0].authorId, "7");
  assert.equal(cursor, "301");
});

test("filterMessages: drops the bot's own non-bot-flagged id too", () => {
  const raw = [msg("400", "app", "self", false)];
  const { messages } = filterMessages(raw, "200", "app", new Set());
  assert.equal(messages.length, 0);
});

test("filterMessages: enforces the allow-list", () => {
  const raw = [msg("500", "7", "ok"), msg("501", "999", "intruder")];
  const { messages } = filterMessages(raw, "200", "app", new Set(["7"]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "ok");
});

test("filterMessages: keeps cursor when batch is empty", () => {
  const { messages, cursor } = filterMessages([], "200", "app", new Set());
  assert.equal(messages.length, 0);
  assert.equal(cursor, "200");
});
