import type { ChoiceLabel } from "@/types/omr";
import type { ExamDefinition } from "@/types/grading";

const parseAnswerKey = (value: string): readonly ChoiceLabel[] => {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (normalized.length !== 100) {
    throw new Error(`Answer key must contain exactly 100 answers; received ${normalized.length}.`);
  }
  if (!/^[ABCD]+$/.test(normalized)) {
    throw new Error("Answer key may contain only A, B, C, or D.");
  }
  return Object.freeze(normalized.split("") as ChoiceLabel[]);
};

const defineExam = (id: string, name: string, key: string): ExamDefinition =>
  Object.freeze({
    id,
    name,
    answerKey: parseAnswerKey(key)
  });

export const examCatalog: readonly ExamDefinition[] = Object.freeze([
  defineExam(
    "math-test-1",
    "Math Test 1",
    `
      DBACBAACBC AADDCCACCD BDADCADDAD BACDDBBCDA ACAACCCAAA
      DDCCDACAAA AAADCBABDB BCABBBCADB CBDCCCCBCC DDCBBBCBBB
    `
  ),
  defineExam(
    "math-test-2",
    "Math Test 2",
    `
      ACBCDAACAC ADBCDBBCAA BCCDBADADB CDDBDDCADA BCBBAAAACA
      AACDAABCDD DCBACABABB AAABCADCBB DADCBABABA DCCBCCDADC
    `
  ),
  defineExam(
    "math-test-3",
    "Math Test 3",
    `
      DBABDCBDBC ABABDADCBA BDAABCDDCB BCCBDCBBAC DBBBDAACDA
      CABDCBABAB ABDDACCACB BACBDBBDAB CCCDAACABA BDCBCADCBA
    `
  ),
  defineExam(
    "math-test-4",
    "Math Test 4",
    `
      BADBCAABAD ACDCDCCDBB CADBACDCDA BABABBDCBB ABCBCBBADB
      AADACCCBAA DAADACBADD ABBDCBBBAA BCCCACCCAC CCDBDBCDDC
    `
  )
]);

const duplicateIds = examCatalog
  .map((exam) => exam.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);

if (duplicateIds.length > 0) {
  throw new Error(`Exam IDs must be unique: ${duplicateIds.join(", ")}`);
}

export const getExamById = (examId: string): ExamDefinition | undefined =>
  examCatalog.find((exam) => exam.id === examId);
