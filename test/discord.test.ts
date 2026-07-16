import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentKind,
  filterMessages,
  toMediaHost,
  type DiscordAttachment,
  type DiscordMessage,
} from "../src/adapters/discord.js";

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

test("toMediaHost: rewrites the proxy-blocked cdn host to the media host", () => {
  assert.equal(
    toMediaHost("https://cdn.discordapp.com/attachments/1/2/x.jpg?ex=a"),
    "https://media.discordapp.net/attachments/1/2/x.jpg?ex=a"
  );
  // Other hosts are left untouched.
  assert.equal(toMediaHost("https://example.com/x.jpg"), "https://example.com/x.jpg");
});

test("attachmentKind: classifies by mime, falling back to extension", () => {
  assert.equal(attachmentKind("image/jpeg", "a.jpg"), "image");
  assert.equal(attachmentKind(undefined, "a.PNG"), "image");
  assert.equal(attachmentKind("audio/ogg", "voice.ogg"), "audio");
  assert.equal(attachmentKind(undefined, "clip.mp4"), "video");
  assert.equal(attachmentKind(undefined, "notes.txt"), "file");
});

test("filterMessages: captures image attachments with rewritten host", () => {
  const att: DiscordAttachment = {
    id: "att1",
    filename: "IMG.jpg",
    content_type: "image/jpeg",
    size: 1234,
    url: "https://cdn.discordapp.com/attachments/9/9/IMG.jpg?ex=z",
    width: 800,
    height: 600,
  };
  const raw: DiscordMessage[] = [{ ...msg("700", "7", "look"), attachments: [att] }];
  const { messages } = filterMessages(raw, "200", "app", new Set());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].attachments?.length, 1);
  assert.equal(messages[0].attachments?.[0].kind, "image");
  assert.equal(messages[0].attachments?.[0].url, "https://media.discordapp.net/attachments/9/9/IMG.jpg?ex=z");
});
