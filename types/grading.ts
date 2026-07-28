import type { ChoiceLabel, OMRResultJson, PhotoQualityReport } from "@/types/omr";

export interface ExamDefinition {
  id: string;
  name: string;
  answerKey: readonly ChoiceLabel[];
}

export type AnswerGradeStatus = "correct" | "wrong" | "blank" | "ambiguous";
export type AnswerOverrideMap = Record<number, ChoiceLabel | null>;

export interface AnswerGrade {
  question: number;
  expected: ChoiceLabel;
  detected: ChoiceLabel[];
  effectiveAnswer: ChoiceLabel | null;
  overridden: boolean;
  confidence: number;
  status: AnswerGradeStatus;
}

export interface SheetGrade {
  examId: string;
  answers: AnswerGrade[];
  correctCount: number;
  wrongCount: number;
  blankCount: number;
  ambiguousCount: number;
  score: number;
  total: number;
  percentage: number;
  quality?: PhotoQualityReport;
}

export interface GradedSheetRecord {
  exam: ExamDefinition;
  result: OMRResultJson;
  overrides: AnswerOverrideMap;
  grade: SheetGrade;
}
