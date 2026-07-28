import type { AnswerOverrideMap } from "@/types/grading";
import type { ChoiceLabel, OMRAnswerJson } from "@/types/omr";

const hasOwn = (overrides: AnswerOverrideMap, question: number) =>
  Object.prototype.hasOwnProperty.call(overrides, question);

export const effectiveAnswerForOverlay = (
  answer: OMRAnswerJson,
  overrides: AnswerOverrideMap
): ChoiceLabel | null => {
  if (hasOwn(overrides, answer.q)) {
    return overrides[answer.q] ?? null;
  }
  return answer.markState === "single" || answer.selected.length === 1
    ? answer.selected[0] ?? null
    : null;
};

export const applyAnswerBubbleClick = (
  answer: OMRAnswerJson,
  overrides: AnswerOverrideMap,
  choice: ChoiceLabel
): AnswerOverrideMap => ({
  ...overrides,
  [answer.q]:
    effectiveAnswerForOverlay(answer, overrides) === choice ? null : choice
});

export const resetAnswerOverrides = (): AnswerOverrideMap => ({});
