import test from "node:test";
import assert from "node:assert/strict";
import { pickDigitByDominance, pickSelections } from "@/lib/omr/bubbleScoring";

test("pickSelections returns single confident selection", () => {
  const result = pickSelections({ A: 0.05, B: 0.12, C: 0.81, D: 0.2 });
  assert.deepEqual(result.selected, ["C"]);
  assert.equal(result.ambiguous, false);
});

test("pickSelections returns ambiguous when top scores are close", () => {
  const result = pickSelections({ A: 0.67, B: 0.65, C: 0.12, D: 0.08 });
  assert.deepEqual(result.selected, []);
  assert.equal(result.ambiguous, true);
});

test("pickDigitByDominance marks blank when none is dominant", () => {
  const result = pickDigitByDominance([0.06, 0.07, 0.05, 0.08, 0.06, 0.07, 0.06, 0.05, 0.07, 0.06]);
  assert.equal(result.detected, -1);
});

test("pickDigitByDominance returns detected index for clear mark", () => {
  const result = pickDigitByDominance([0.04, 0.06, 0.07, 0.08, 0.34, 0.05, 0.04, 0.06, 0.07, 0.05]);
  assert.equal(result.detected, 4);
});
