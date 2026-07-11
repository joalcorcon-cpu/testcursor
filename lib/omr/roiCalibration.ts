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

const mapRegion = (
  region: BubbleRegion,
  sourceBounds: BubbleRegion,
  targetBounds: BubbleRegion
): BubbleRegion => {
  const nx = sourceBounds.w > 0 ? (region.x - sourceBounds.x) / sourceBounds.w : 0;
  const ny = sourceBounds.h > 0 ? (region.y - sourceBounds.y) / sourceBounds.h : 0;
  const nw = sourceBounds.w > 0 ? region.w / sourceBounds.w : 0;
  const nh = sourceBounds.h > 0 ? region.h / sourceBounds.h : 0;
  return {
    x: targetBounds.x + nx * targetBounds.w,
    y: targetBounds.y + ny * targetBounds.h,
    w: nw * targetBounds.w,
    h: nh * targetBounds.h
  };
};

const toBoxMap = (boxes: RoiBoxVisual[]) =>
  new Map<RoiBoxId, BubbleRegion>(
    boxes.map((box) => [box.id, { x: box.x, y: box.y, w: box.w, h: box.h }])
  );

export const deriveRoiBoxesFromTemplate = (template: OMRTemplate): RoiBoxVisual[] => {
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
  const sourceBoxes = toBoxMap(deriveRoiBoxesFromTemplate(template));
  const targetBoxes = toBoxMap(nextRoiBoxes);

  const getMapping = (id: RoiBoxId): { source: BubbleRegion; target: BubbleRegion } => {
    const source = sourceBoxes.get(id);
    if (!source) {
      throw new Error(`Source ROI not found for ${id}`);
    }
    const target = targetBoxes.get(id) ?? source;
    return { source, target };
  };

  const studentMap = getMapping("studentId");
  const examCodeMap = getMapping("examCode");
  const examSetMap = getMapping("examSet");
  const answersCol1Map = getMapping("answersCol1");
  const answersCol2Map = getMapping("answersCol2");
  const answersCol3Map = getMapping("answersCol3");

  return {
    ...template,
    studentId: {
      ...template.studentId,
      columns: template.studentId.columns.map((column) =>
        column.map((bubble) => mapRegion(bubble, studentMap.source, studentMap.target))
      )
    },
    examCode: {
      ...template.examCode,
      columns: template.examCode.columns.map((column) =>
        column.map((bubble) => mapRegion(bubble, examCodeMap.source, examCodeMap.target))
      )
    },
    examSet: {
      ...template.examSet,
      choices: {
        A: mapRegion(template.examSet.choices.A, examSetMap.source, examSetMap.target),
        B: mapRegion(template.examSet.choices.B, examSetMap.source, examSetMap.target),
        C: mapRegion(template.examSet.choices.C, examSetMap.source, examSetMap.target),
        D: mapRegion(template.examSet.choices.D, examSetMap.source, examSetMap.target)
      }
    },
    answers: template.answers.map((item) => {
      const answerMap =
        item.question <= 35
          ? answersCol1Map
          : item.question <= 70
            ? answersCol2Map
            : answersCol3Map;
      return {
        ...item,
        choices: {
          A: mapRegion(item.choices.A, answerMap.source, answerMap.target),
          B: mapRegion(item.choices.B, answerMap.source, answerMap.target),
          C: mapRegion(item.choices.C, answerMap.source, answerMap.target),
          D: mapRegion(item.choices.D, answerMap.source, answerMap.target)
        }
      };
    })
  };
};
