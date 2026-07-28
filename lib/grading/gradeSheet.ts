import type { ChoiceLabel, ChoiceScores, OMRAnswerJson, OMRResultJson } from "@/types/omr";
import type {
  AnswerGrade,
  AnswerOverrideMap,
  ExamDefinition,
  SheetGrade
} from "@/types/grading";

const choices: ChoiceLabel[] = ["A", "B", "C", "D"];

const hasOwn = (record: AnswerOverrideMap, question: number) =>
  Object.prototype.hasOwnProperty.call(record, question);

const maxScore = (scores: ChoiceScores) =>
  Math.max(...choices.map((choice) => scores[choice] ?? 0));

const inferDetectedState = (
  answer: OMRAnswerJson,
  darknessThreshold: number
): "blank" | "ambiguous" | "single" => {
  if (answer.markState) {
    return answer.markState;
  }
  if (answer.selected.length === 1) {
    return "single";
  }
  return maxScore(answer.normalizedScores ?? answer.shadeScores) >= darknessThreshold
    ? "ambiguous"
    : "blank";
};

const gradeAnswer = (
  answer: OMRAnswerJson,
  expected: ChoiceLabel,
  overrides: AnswerOverrideMap,
  darknessThreshold: number
): AnswerGrade => {
  const overridden = hasOwn(overrides, answer.q);
  if (overridden) {
    const override = overrides[answer.q];
    return {
      question: answer.q,
      expected,
      detected: answer.selected,
      effectiveAnswer: override,
      overridden: true,
      confidence: 1,
      status: override === null ? "blank" : override === expected ? "correct" : "wrong"
    };
  }

  const detectedState = inferDetectedState(answer, darknessThreshold);
  const effectiveAnswer = answer.selected.length === 1 ? answer.selected[0] : null;
  const status =
    detectedState === "blank"
      ? "blank"
      : detectedState === "ambiguous"
        ? "ambiguous"
        : effectiveAnswer === expected
          ? "correct"
          : "wrong";

  return {
    question: answer.q,
    expected,
    detected: answer.selected,
    effectiveAnswer,
    overridden: false,
    confidence: answer.confidence,
    status
  };
};

export const gradeSheet = (
  result: OMRResultJson,
  exam: ExamDefinition,
  overrides: AnswerOverrideMap = {},
  darknessThreshold = 0.28
): SheetGrade => {
  if (exam.answerKey.length !== 100) {
    throw new Error(`Exam ${exam.id} does not have a 100-item answer key.`);
  }

  const byQuestion = new Map(result.answers.map((answer) => [answer.q, answer]));
  const answers = exam.answerKey.map((expected, index) => {
    const question = index + 1;
    const detected =
      byQuestion.get(question) ??
      ({
        q: question,
        selected: [],
        shadeScores: { A: 0, B: 0, C: 0, D: 0 },
        confidence: 0,
        ambiguous: true,
        markState: "blank"
      } satisfies OMRAnswerJson);
    return gradeAnswer(detected, expected, overrides, darknessThreshold);
  });

  const count = (status: AnswerGrade["status"]) =>
    answers.filter((answer) => answer.status === status).length;
  const correctCount = count("correct");
  const total = exam.answerKey.length;

  return {
    examId: exam.id,
    answers,
    correctCount,
    wrongCount: count("wrong"),
    blankCount: count("blank"),
    ambiguousCount: count("ambiguous"),
    score: correctCount,
    total,
    percentage: total > 0 ? Math.round((correctCount / total) * 10000) / 100 : 0,
    quality: result.pipeline.quality
  };
};
