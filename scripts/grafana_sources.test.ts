import assert from "node:assert/strict";
import { test } from "node:test";
import { errorRows, instanceRows, type Sample } from "./grafana_sources.js";

function sample(metric: Record<string, string>, value: number): Sample {
  return { metric, value: [0, String(value)] };
}

test("joins CPU and disk by instance, not vector ordering", () => {
  assert.deepEqual(instanceRows([sample({ instance: "app" }, 1.234)], [sample({ instance: "prod1" }, 82), sample({ instance: "app" }, 30)]), [
    { instance: "app", cpu: "1.23%", disk: "30.00%" },
    { instance: "prod1", cpu: "N/A", disk: "82.00%" },
  ]);
});

test("aggregates the same error across instances before thresholding", () => {
  const rows = errorRows([
    sample({ instance: "prod1", error_message: "Deletion failed", error_code: "P2014" }, 6),
    sample({ instance: "app", error_message: "Deletion failed", error_code: "P2014" }, 5),
    sample({ instance: "app", error_message: "Other error" }, 20),
    sample({ instance: "app", error_message: "Rare error" }, 1),
  ], 10);
  assert.deepEqual(rows, [
    { unique_error: "Other error", instances: "app", occurrences: 20 },
    { unique_error: "Deletion failed — P2014", instances: "app, prod1", occurrences: 11 },
  ]);
});

test("does not combine different error codes", () => {
  assert.equal(errorRows([
    sample({ instance: "app", error_message: "Deletion failed", error_code: "P2014" }, 6),
    sample({ instance: "app", error_message: "Deletion failed", error_code: "P2001" }, 6),
  ], 10).length, 0);
});

test("empty instance metrics fail rather than look healthy", () => {
  assert.throws(() => instanceRows([], []), /no CPU or disk/);
});
