import type {
  AnswerItemRegion,
  BubbleRegion,
  ChoiceLabel,
  OMRTemplate
} from "@/types/omr";

const makeChoiceRow = (
  startX: number,
  y: number,
  bubbleSize: number,
  gap: number
): Record<ChoiceLabel, BubbleRegion> => ({
  A: { x: startX + 0 * gap, y, w: bubbleSize, h: bubbleSize },
  B: { x: startX + 1 * gap, y, w: bubbleSize, h: bubbleSize },
  C: { x: startX + 2 * gap, y, w: bubbleSize, h: bubbleSize },
  D: { x: startX + 3 * gap, y, w: bubbleSize, h: bubbleSize }
});

const makeDigitColumns = (
  startX: number,
  startY: number,
  columnCount: number
): BubbleRegion[][] => {
  const columns: BubbleRegion[][] = [];
  const columnGap = 0.036;
  const rowGap = 0.028;
  const bubbleSize = 0.017;
  for (let c = 0; c < columnCount; c += 1) {
    const col: BubbleRegion[] = [];
    for (let r = 0; r < 10; r += 1) {
      col.push({
        x: startX + c * columnGap,
        y: startY + r * rowGap,
        w: bubbleSize,
        h: bubbleSize
      });
    }
    columns.push(col);
  }
  return columns;
};

const buildAnswers = (): AnswerItemRegion[] => {
  const answers: AnswerItemRegion[] = [];
  const columnStarts = [0.415, 0.618, 0.82];
  const rowStart = 0.15;
  const rowGap = 0.0264;
  const bubbleSize = 0.0175;
  const choiceGap = 0.026;

  for (let q = 1; q <= 100; q += 1) {
    const columnIndex = Math.floor((q - 1) / 35);
    const inColumnIndex = (q - 1) % 35;
    const y = rowStart + inColumnIndex * rowGap;
    answers.push({
      question: q,
      choices: makeChoiceRow(columnStarts[columnIndex], y, bubbleSize, choiceGap)
    });
  }

  return answers;
};

export const defaultSheetTemplate: OMRTemplate = {
  id: "default-aerc-100q-v1",
  name: "AERC 100Q (Sample)",
  version: 1,
  sheetWidth: 1,
  sheetHeight: 1,
  cornerMarkers: [
    { id: "tl", x: 0.038, y: 0.045, w: 0.018, h: 0.018 },
    { id: "tr", x: 0.944, y: 0.046, w: 0.018, h: 0.018 },
    { id: "br", x: 0.944, y: 0.959, w: 0.018, h: 0.018 },
    { id: "bl", x: 0.038, y: 0.958, w: 0.018, h: 0.018 }
  ],
  studentId: {
    key: "studentId",
    digits: 6,
    bubbleRows: 10,
    columns: makeDigitColumns(0.156, 0.262, 6)
  },
  examCode: {
    key: "examCode",
    digits: 3,
    bubbleRows: 10,
    columns: makeDigitColumns(0.156, 0.593, 3)
  },
  examSet: {
    choices: makeChoiceRow(0.155, 0.818, 0.0175, 0.026)
  },
  answers: buildAnswers()
};
