import type {
  BubbleRegion,
  ChoiceLabel,
  ChoiceScores,
  OMRAnswerJson
} from "@/types/omr";
import type { CvMat } from "@/lib/omr/opencvLoader";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface DigitDominanceOptions {
  minTopScore?: number;
  minGapToSecond?: number;
  minStdMultiplier?: number;
}

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
  const total = rect.width * rect.height;
  const ink =
    typeof window !== "undefined" && window.cv?.countNonZero
      ? window.cv.countNonZero(roi)
      : (() => {
          let fallbackInk = 0;
          for (let y = 0; y < rect.height; y += 1) {
            for (let x = 0; x < rect.width; x += 1) {
              if (roi.ucharPtr(y, x)[0] > 0) {
                fallbackInk += 1;
              }
            }
          }
          return fallbackInk;
        })();
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
  const ambiguous = selected.length !== 1;
  return {
    selected: ambiguous ? [] : selected,
    confidence,
    ambiguous
  };
};

export const pickDigitByDominance = (
  scores: number[],
  options: DigitDominanceOptions = {}
) => {
  if (scores.length === 0) {
    return { detected: -1, confidence: 0 };
  }
  const {
    minTopScore = 0.12,
    minGapToSecond = 0.025,
    minStdMultiplier = 1.2
  } = options;
  const ranked = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1] ?? { score: 0, index: -1 };
  const others = ranked.slice(1).map((item) => item.score);
  const meanOthers =
    others.length > 0
      ? others.reduce((sum, value) => sum + value, 0) / others.length
      : 0;
  const variance =
    others.length > 0
      ? others.reduce((sum, value) => sum + (value - meanOthers) ** 2, 0) / others.length
      : 0;
  const stdOthers = Math.sqrt(variance);
  const isDominant =
    top.score >= minTopScore &&
    top.score - second.score >= minGapToSecond &&
    top.score >= meanOthers + stdOthers * minStdMultiplier;

  return {
    detected: isDominant ? top.index : -1,
    confidence: clamp(top.score - second.score, 0, 1)
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
