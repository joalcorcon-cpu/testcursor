import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAnswerBubbleClick,
  effectiveAnswerForOverlay,
  resetAnswerOverrides
} from "@/lib/grading/answerOverrides";
import type { OMRAnswerJson } from "@/types/omr";

const answer: OMRAnswerJson = {
  q: 7,
  selected: ["B"],
  shadeScores: { A: 0.1, B: 0.8, C: 0.1, D: 0.05 },
  normalizedScores: { A: 0.05, B: 0.9, C: 0.04, D: 0.01 },
  confidence: 0.7,
  ambiguous: false,
  markState: "single"
};

test("clicking a different answer creates a separate override", () => {
  const overrides = applyAnswerBubbleClick(answer, {}, "D");
  assert.deepEqual(overrides, { 7: "D" });
  assert.equal(effectiveAnswerForOverlay(answer, overrides), "D");
  assert.deepEqual(answer.selected, ["B"]);
});

test("clicking the active answer creates an explicit blank", () => {
  assert.deepEqual(applyAnswerBubbleClick(answer, {}, "B"), { 7: null });
  assert.deepEqual(applyAnswerBubbleClick(answer, { 7: "D" }, "D"), { 7: null });
});

test("resetting restores the detected answer", () => {
  const reset = resetAnswerOverrides();
  assert.deepEqual(reset, {});
  assert.equal(effectiveAnswerForOverlay(answer, reset), "B");
});
