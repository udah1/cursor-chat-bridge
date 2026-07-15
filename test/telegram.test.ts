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
