import type {
  BubbleRegion,
  ChoiceLabel,
  ChoiceScores,
  OMRAnswerJson
} from "@/types/omr";
import type { CvMat } from "@/lib/omr/opencvLoader";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const normalizeRegion = (
  region: BubbleRegion,
  width: number,
  height: number
) => {
  const x = clamp(Math.round(region.x * width), 0, width - 1);
  const y = clamp(Math.round(region.y * height), 0, height - 1);
  const w = clamp(Math.round(region.w * width), 1, width - x);
  const h = clamp(Math.round(region.h * height), 1, height - y);
  return { x, y, width: w, height: h };
};

export const regionShadeScore = (
  thresholded: CvMat,
  region: BubbleRegion
): number => {
  const rect = normalizeRegion(region, thresholded.cols, thresholded.rows);
  const roi = thresholded.roi(rect);
  let ink = 0;
  const total = rect.width * rect.height;
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      if (roi.ucharPtr(y, x)[0] > 0) {
        ink += 1;
      }
    }
  }
  roi.delete();
  return total > 0 ? ink / total : 0;
};

export const computeChoiceScores = (
  thresholded: CvMat,
  choices: Record<ChoiceLabel, BubbleRegion>
): ChoiceScores => ({
  A: regionShadeScore(thresholded, choices.A),
  B: regionShadeScore(thresholded, choices.B),
  C: regionShadeScore(thresholded, choices.C),
  D: regionShadeScore(thresholded, choices.D)
});

export const pickSelections = (
  scores: ChoiceScores,
  minMarkThreshold = 0.18,
  ambiguityGap = 0.03
) => {
  const sorted = (Object.entries(scores) as [ChoiceLabel, number][])
    .sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const second = sorted[1];
  const selected = sorted
    .filter(([, score]) => score >= minMarkThreshold && top[1] - score <= ambiguityGap)
    .map(([choice]) => choice);
  const confidence = clamp(top[1] - second[1], 0, 1);
  return {
    selected: selected.length > 0 ? selected : [],
    confidence,
    ambiguous: selected.length !== 1
  };
};

export const scoreAnswer = (
  q: number,
  thresholded: CvMat,
  choices: Record<ChoiceLabel, BubbleRegion>
): OMRAnswerJson => {
  const shadeScores = computeChoiceScores(thresholded, choices);
  const { selected, confidence, ambiguous } = pickSelections(shadeScores);
  return {
    q,
    selected,
    shadeScores,
    confidence,
    ambiguous
  };
};
