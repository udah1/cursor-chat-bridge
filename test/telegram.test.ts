import { test } from "node:test";
import assert from "node:assert/strict";
import { routeUpdates, type TgUpdate } from "../src/adapters/telegram.js";

test("routeUpdates: routes threaded messages and advances offset", () => {
  const updates: TgUpdate[] = [
    { update_id: 10, message: { message_id: 1, date: 100, message_thread_id: 55, text: "hi", from: { id: 7 } } },
    { update_id: 11, message: { message_id: 2, date: 101, text: "no thread", from: { id: 7 } } }, // dropped: no thread
    { update_id: 12, message: { message_id: 3, date: 102, message_thread_id: 55, text: "again", from: { id: 7 } } },
  ];
  const { routed, nextOffset } = routeUpdates(updates, new Set(["7"]));
  assert.equal(nextOffset, 13);
  assert.equal(routed.length, 2);
  assert.equal(routed[0].thread, "55");
  assert.equal(routed[0].msg.text, "hi");
  assert.equal(routed[0].msg.ts, 100000);
});

test("routeUpdates: enforces the allow-list", () => {
  const updates: TgUpdate[] = [
    { update_id: 1, message: { message_id: 1, date: 1, message_thread_id: 9, text: "ok", from: { id: 7 } } },
    { update_id: 2, message: { message_id: 2, date: 2, message_thread_id: 9, text: "intruder", from: { id: 999 } } },
  ];
  const { routed } = routeUpdates(updates, new Set(["7"]));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].msg.text, "ok");
});

test("routeUpdates: empty allow-list allows all", () => {
  const updates: TgUpdate[] = [
    { update_id: 1, message: { message_id: 1, date: 1, message_thread_id: 9, text: "anyone", from: { id: 123 } } },
  ];
  const { routed } = routeUpdates(updates, new Set());
  assert.equal(routed.length, 1);
});

test("routeUpdates: captures a photo (largest size) with caption as text", () => {
  const updates: TgUpdate[] = [
    {
      update_id: 20,
      message: {
        message_id: 5,
        date: 5,
        message_thread_id: 9,
        caption: "check this",
        from: { id: 7 },
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 90, height: 90, file_size: 900 },
          { file_id: "big", file_unique_id: "u2", width: 800, height: 800, file_size: 90000 },
        ],
      },
    },
  ];
  const { routed } = routeUpdates(updates, new Set(["7"]));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].msg.text, "check this");
  assert.equal(routed[0].msg.attachments?.length, 1);
  assert.equal(routed[0].msg.attachments?.[0].kind, "image");
  assert.equal(routed[0].msg.attachments?.[0].ref, "big"); // largest size chosen
});

test("routeUpdates: captures an image document even without text", () => {
  const updates: TgUpdate[] = [
    {
      update_id: 30,
      message: {
        message_id: 6,
        date: 6,
        message_thread_id: 9,
        from: { id: 7 },
        document: { file_id: "doc1", file_name: "scan.png", mime_type: "image/png", file_size: 4242 },
      },
    },
  ];
  const { routed } = routeUpdates(updates, new Set(["7"]));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].msg.text, "");
  assert.equal(routed[0].msg.attachments?.[0].ref, "doc1");
  assert.equal(routed[0].msg.attachments?.[0].filename, "scan.png");
});

test("routeUpdates: skips non-image documents and empty messages", () => {
  const updates: TgUpdate[] = [
    {
      update_id: 40,
      message: {
        message_id: 7,
        date: 7,
        message_thread_id: 9,
        from: { id: 7 },
        document: { file_id: "pdf1", file_name: "doc.pdf", mime_type: "application/pdf" },
      },
    },
  ];
  const { routed } = routeUpdates(updates, new Set(["7"]));
  assert.equal(routed.length, 0); // no text, no image attachment
});
