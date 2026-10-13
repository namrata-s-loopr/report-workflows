import assert from "node:assert/strict";
import { test } from "node:test";
import { tenantRows } from "./kuma_source.js";

test("Kuma status reflects active, paused, down and missing readings", () => {
  const monitors = { "1": { id: 1, name: "one", active: true }, "2": { id: 2, name: "two", active: false }, "3": { id: 3, name: "three", active: true }, "4": { id: 4, name: "four", active: true } };
  const rows = tenantRows([1, 2, 3, 4].map((monitorId) => ({ tenant: String(monitorId), monitorId })), monitors, new Map([[1, { status: 1 }], [2, { status: 1 }], [3, { status: 0 }]]), new Map([[1, 1], [2, 0], [3, 0.98]]));
  assert.deepEqual(rows.map((row) => row.kuma_and_elk), ["OK — 100.00%", "Paused — 0.00%", "Down — 98.00%", "Unknown — N/A"]);
  assert.ok(rows.every((row) => row.sanity_check === "Not collected"));
});

test("missing configured Kuma monitor fails", () => {
  assert.throws(() => tenantRows([{ tenant: "Tenant", monitorId: 9 }], {}, new Map(), new Map()), /missing/);
});
