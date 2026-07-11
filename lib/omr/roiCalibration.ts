import type { BubbleRegion, OMRTemplate } from "@/types/omr";

export type RoiBoxId =
  | "studentId"
  | "examCode"
  | "examSet"
  | "answersCol1"
  | "answersCol2"
  | "answersCol3";

export interface RoiBoxVisual {
  id: RoiBoxId;
  x: number;
  y: number;
  w: number;
  h: number;
}

const flattenRegions = (groups: BubbleRegion[][]): BubbleRegion[] =>
  groups.flatMap((group) => group);

const regionBounds = (regions: BubbleRegion[]): BubbleRegion => {
  const left = Math.min(...regions.map((region) => region.x));
  const top = Math.min(...regions.map((region) => region.y));
  const right = Math.max(...regions.map((region) => region.x + region.w));
  const bottom = Math.max(...regions.map((region) => region.y + region.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
};

const toBoxMap = (boxes: RoiBoxVisual[]) =>
  new Map<RoiBoxId, BubbleRegion>(
    boxes.map((box) => [box.id, { x: box.x, y: box.y, w: box.w, h: box.h }])
  );

const makeCellBubble = (
  box: BubbleRegion,
  cols: number,
  rows: number,
  colIndex: number,
  rowIndex: number,
  fill = 0.64
): BubbleRegion => {
  const spanX = cols > 1 ? box.w / (cols - 1) : box.w;
  const spanY = rows > 1 ? box.h / (rows - 1) : box.h;
  const bubbleWidth =
    cols > 1 ? Math.max(0.002, Math.min(box.w, spanX * fill)) : Math.max(0.002, box.w);
  const bubbleHeight =
    rows > 1 ? Math.max(0.002, Math.min(box.h, spanY * fill)) : Math.max(0.002, box.h);
  const startCenterX = box.x + bubbleWidth / 2;
  const endCenterX = box.x + box.w - bubbleWidth / 2;
  const startCenterY = box.y + bubbleHeight / 2;
  const endCenterY = box.y + box.h - bubbleHeight / 2;
  const centerX =
    cols > 1
      ? startCenterX + ((endCenterX - startCenterX) * colIndex) / (cols - 1)
      : box.x + box.w / 2;
  const centerY =
    rows > 1
      ? startCenterY + ((endCenterY - startCenterY) * rowIndex) / (rows - 1)
      : box.y + box.h / 2;
  return {
    x: centerX - bubbleWidth / 2,
    y: centerY - bubbleHeight / 2,
    w: bubbleWidth,
    h: bubbleHeight
  };
};

const buildDigitColumnsFromBox = (box: BubbleRegion, digits: number, rows: number): BubbleRegion[][] => {
  const columns: BubbleRegion[][] = [];
  for (let col = 0; col < digits; col += 1) {
    const bubbles: BubbleRegion[] = [];
    for (let row = 0; row < rows; row += 1) {
      bubbles.push(makeCellBubble(box, digits, rows, col, row));
    }
    columns.push(bubbles);
  }
  return columns;
};

const buildExamSetChoicesFromBox = (box: BubbleRegion) => ({
  A: makeCellBubble(box, 4, 1, 0, 0),
  B: makeCellBubble(box, 4, 1, 1, 0),
  C: makeCellBubble(box, 4, 1, 2, 0),
  D: makeCellBubble(box, 4, 1, 3, 0)
});

const buildAnswersForColumn = (
  box: BubbleRegion,
  startQuestion: number,
  count: number
) =>
  Array.from({ length: count }, (_, idx) => {
    const question = startQuestion + idx;
    return {
      question,
      choices: {
        A: makeCellBubble(box, 4, count, 0, idx),
        B: makeCellBubble(box, 4, count, 1, idx),
        C: makeCellBubble(box, 4, count, 2, idx),
        D: makeCellBubble(box, 4, count, 3, idx)
      }
    };
  });

export const deriveRoiBoxesFromTemplate = (template: OMRTemplate): RoiBoxVisual[] => {
  const storedBoxes = template.roiCalibrationBoxes;
  if (
    storedBoxes?.studentId &&
    storedBoxes.examCode &&
    storedBoxes.examSet &&
    storedBoxes.answersCol1 &&
    storedBoxes.answersCol2 &&
    storedBoxes.answersCol3
  ) {
    return [
      { id: "studentId", ...storedBoxes.studentId },
      { id: "examCode", ...storedBoxes.examCode },
      { id: "examSet", ...storedBoxes.examSet },
      { id: "answersCol1", ...storedBoxes.answersCol1 },
      { id: "answersCol2", ...storedBoxes.answersCol2 },
      { id: "answersCol3", ...storedBoxes.answersCol3 }
    ];
  }

  const studentBounds = regionBounds(flattenRegions(template.studentId.columns));
  const examCodeBounds = regionBounds(flattenRegions(template.examCode.columns));
  const examSetBounds = regionBounds(Object.values(template.examSet.choices));
  const answersFirstColBounds = regionBounds(
    template.answers
      .filter((item) => item.question <= 35)
      .flatMap((item) => Object.values(item.choices))
  );
  const answersSecondColBounds = regionBounds(
    template.answers
      .filter((item) => item.question >= 36 && item.question <= 70)
      .flatMap((item) => Object.values(item.choices))
  );
  const answersThirdColBounds = regionBounds(
    template.answers
      .filter((item) => item.question >= 71)
      .flatMap((item) => Object.values(item.choices))
  );

  return [
    { id: "studentId", ...studentBounds },
    { id: "examCode", ...examCodeBounds },
    { id: "examSet", ...examSetBounds },
    { id: "answersCol1", ...answersFirstColBounds },
    { id: "answersCol2", ...answersSecondColBounds },
    { id: "answersCol3", ...answersThirdColBounds }
  ];
};

export const applyRoiBoxesToTemplate = (
  template: OMRTemplate,
  nextRoiBoxes: RoiBoxVisual[]
): OMRTemplate => {
  const targetBoxes = toBoxMap(nextRoiBoxes);
  const defaults = toBoxMap(deriveRoiBoxesFromTemplate(template));
  const resolve = (id: RoiBoxId): BubbleRegion => {
    const fromTarget = targetBoxes.get(id);
    if (fromTarget) {
      return fromTarget;
    }
    const fallback = defaults.get(id);
    if (!fallback) {
      throw new Error(`Missing ROI box for ${id}`);
    }
    return fallback;
  };

  const studentBox = resolve("studentId");
  const examCodeBox = resolve("examCode");
  const examSetBox = resolve("examSet");
  const answersCol1Box = resolve("answersCol1");
  const answersCol2Box = resolve("answersCol2");
  const answersCol3Box = resolve("answersCol3");

  return {
    ...template,
    roiCalibrationBoxes: {
      studentId: studentBox,
      examCode: examCodeBox,
      examSet: examSetBox,
      answersCol1: answersCol1Box,
      answersCol2: answersCol2Box,
      answersCol3: answersCol3Box
    },
    studentId: {
      ...template.studentId,
      columns: buildDigitColumnsFromBox(
        studentBox,
        template.studentId.digits,
        template.studentId.bubbleRows
      )
    },
    examCode: {
      ...template.examCode,
      columns: buildDigitColumnsFromBox(
        examCodeBox,
        template.examCode.digits,
        template.examCode.bubbleRows
      )
    },
    examSet: {
      ...template.examSet,
      choices: buildExamSetChoicesFromBox(examSetBox)
    },
    answers: [
      ...buildAnswersForColumn(answersCol1Box, 1, 35),
      ...buildAnswersForColumn(answersCol2Box, 36, 35),
      ...buildAnswersForColumn(answersCol3Box, 71, 30)
    ]
  };
};
