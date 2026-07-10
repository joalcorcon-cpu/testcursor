import test from "node:test";
import assert from "node:assert/strict";
import { pickSelections } from "@/lib/omr/bubbleScoring";

test("pickSelections returns single confident selection", () => {
  const result = pickSelections({ A: 0.05, B: 0.12, C: 0.81, D: 0.2 });
  assert.deepEqual(result.selected, ["C"]);
  assert.equal(result.ambiguous, false);
});

test("pickSelections returns ambiguous when top scores are close", () => {
  const result = pickSelections({ A: 0.67, B: 0.65, C: 0.12, D: 0.08 });
  assert.deepEqual(result.selected, ["A", "B"]);
  assert.equal(result.ambiguous, true);
});
