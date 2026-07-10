import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import {
  computeChoiceScores,
  pickSelections,
  regionShadeScore,
  scoreAnswer
} from "@/lib/omr/bubbleScoring";
import { loadOpenCv } from "@/lib/omr/opencvLoader";
import type { CvMat } from "@/lib/omr/opencvLoader";
import type { OMRResultJson } from "@/types/omr";

const loadImageElement = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode image."));
    };
    image.src = url;
  });

const toThresholdedMat = async (file: File): Promise<CvMat> => {
  const cv = await loadOpenCv();
  const image = await loadImageElement(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to initialize canvas context.");
  }
  ctx.drawImage(image, 0, 0);

  const src = cv.imread(canvas);
  const gray = new cv.Mat() as CvMat;
  const blurred = new cv.Mat() as CvMat;
  const binary = new cv.Mat() as CvMat;
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, { width: 5, height: 5 }, 0, 0);
  cv.adaptiveThreshold(
    blurred,
    binary,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV,
    17,
    5
  );
  src.delete();
  gray.delete();
  blurred.delete();
  return binary;
};

const scoreDigitColumns = (thresholded: CvMat, columns: { x: number; y: number; w: number; h: number }[][]) => {
  const shadeScores = columns.map((column) =>
    column.map((bubble) => regionShadeScore(thresholded, bubble))
  );
  const detected = shadeScores.map((scores) => {
    let bestIndex = 0;
    let bestScore = -1;
    scores.forEach((score, index) => {
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  });
  return { detected, shadeScores };
};

export const processSheetFile = async (file: File): Promise<OMRResultJson> => {
  const thresholded = await toThresholdedMat(file);
  try {
    const studentId = scoreDigitColumns(thresholded, defaultSheetTemplate.studentId.columns);
    const examCode = scoreDigitColumns(thresholded, defaultSheetTemplate.examCode.columns);
    const examSetScores = computeChoiceScores(thresholded, defaultSheetTemplate.examSet.choices);
    const examSetDecision = pickSelections(examSetScores);
    const answers = defaultSheetTemplate.answers.map((item) =>
      scoreAnswer(item.question, thresholded, item.choices)
    );

    return {
      templateId: defaultSheetTemplate.id,
      student: {
        studentId,
        examCode,
        examSet: {
          selected: examSetDecision.selected,
          shadeScores: examSetScores,
          confidence: examSetDecision.confidence,
          ambiguous: examSetDecision.ambiguous
        }
      },
      answers,
      pipeline: {
        warped: false,
        width: thresholded.cols,
        height: thresholded.rows
      }
    };
  } finally {
    thresholded.delete();
  }
};
