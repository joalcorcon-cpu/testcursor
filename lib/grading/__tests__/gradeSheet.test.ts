import test from "node:test";
import assert from "node:assert/strict";
import { examCatalog } from "@/lib/exams/examCatalog";
import { gradeSheet } from "@/lib/grading/gradeSheet";
import type { ChoiceLabel, OMRAnswerJson, OMRResultJson } from "@/types/omr";

const exam = examCatalog[0];

const answer = (
  q: number,
  selected: ChoiceLabel[],
  options: Partial<OMRAnswerJson> = {}
): OMRAnswerJson => ({
  q,
  selected,
  shadeScores: { A: 0.05, B: 0.05, C: 0.05, D: 0.05 },
  normalizedScores: { A: 0.05, B: 0.05, C: 0.05, D: 0.05 },
  confidence: selected.length === 1 ? 0.8 : 0,
  ambiguous: selected.length !== 1,
  markState: selected.length === 1 ? "single" : "blank",
  ...options
});

const resultWith = (answers: OMRAnswerJson[]): OMRResultJson => ({
  templateId: "test",
  student: {
    studentId: { detected: [1, 2, 3, 4, 5, 6], shadeScores: [] },
    examCode: { detected: [1, 0, 1], shadeScores: [] },
    examSet: {
      selected: ["A"],
      shadeScores: { A: 1, B: 0, C: 0, D: 0 },
      confidence: 1,
      ambiguous: false
    }
  },
  answers,
  pipeline: { warped: true, width: 1000, height: 1400 }
});

test("catalog contains four valid 100-item keys", () => {
  assert.equal(examCatalog.length, 4);
  for (const entry of examCatalog) {
    assert.equal(entry.answerKey.length, 100);
    assert.ok(entry.answerKey.every((choice) => ["A", "B", "C", "D"].includes(choice)));
  }
});

test("grades a perfect sheet", () => {
  const result = resultWith(
    exam.answerKey.map((choice, index) => answer(index + 1, [choice]))
  );
  const grade = gradeSheet(result, exam);
  assert.equal(grade.score, 100);
  assert.equal(grade.percentage, 100);
  assert.equal(grade.wrongCount, 0);
});

test("tracks wrong, blank, and ambiguous answers separately", () => {
  const first = exam.answerKey[0];
  const wrong = first === "A" ? "B" : "A";
  const result = resultWith([
    answer(1, [wrong]),
    answer(2, [], { markState: "blank" }),
    answer(3, [], {
      markState: "ambiguous",
      normalizedScores: { A: 0.5, B: 0.48, C: 0.02, D: 0.01 }
    })
  ]);
  const grade = gradeSheet(result, exam);
  assert.equal(grade.wrongCount, 1);
  assert.equal(grade.blankCount, 98);
  assert.equal(grade.ambiguousCount, 1);
});

test("manual answer and blank overrides rescore without changing detection", () => {
  const result = resultWith([answer(1, [])]);
  const corrected = gradeSheet(result, exam, { 1: exam.answerKey[0] });
  assert.equal(corrected.answers[0].status, "correct");
  assert.deepEqual(result.answers[0].selected, []);

  const blanked = gradeSheet(
    resultWith([answer(1, [exam.answerKey[0]])]),
    exam,
    { 1: null }
  );
  assert.equal(blanked.answers[0].status, "blank");
  assert.equal(blanked.score, 0);
});

test("resetting an override restores the original detection", () => {
  const wrongChoice = exam.answerKey[0] === "A" ? "B" : "A";
  const result = resultWith([answer(1, [wrongChoice])]);
  const withOverride = gradeSheet(result, exam, { 1: exam.answerKey[0] });
  assert.equal(withOverride.answers[0].status, "correct");
  assert.equal(withOverride.answers[0].overridden, true);

  const resetToDetected = gradeSheet(result, exam, {});
  assert.equal(resetToDetected.answers[0].status, "wrong");
  assert.equal(resetToDetected.answers[0].effectiveAnswer, wrongChoice);
  assert.equal(resetToDetected.answers[0].overridden, false);
});
