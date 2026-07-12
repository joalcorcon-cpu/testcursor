import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import {
  computeChoiceScores,
  normalizeRegion,
  pickDigitByDominance,
  pickSelections,
  regionShadeScore,
  scoreAnswer
} from "@/lib/omr/bubbleScoring";
import { loadOpenCv } from "@/lib/omr/opencvLoader";
import type { CvMat } from "@/lib/omr/opencvLoader";
import type { CornerMarker, OMRResultJson } from "@/types/omr";

const MAX_PROCESSING_DIMENSION = 800;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });

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

interface PreprocessedSheet {
  thresholded: CvMat;
  warped: boolean;
}

interface CornerPoint {
  x: number;
  y: number;
}

const fallbackCornerPoint = (marker: CornerMarker, width: number, height: number): CornerPoint => ({
  x: (marker.x + marker.w / 2) * width,
  y: (marker.y + marker.h / 2) * height
});

const detectCornerPoint = (thresholded: CvMat, marker: CornerMarker): CornerPoint => {
  const rect = normalizeRegion(marker, thresholded.cols, thresholded.rows);
  const roi = thresholded.roi(rect);
  let count = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      if (roi.ucharPtr(y, x)[0] > 0) {
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }

  roi.delete();

  if (count < rect.width * rect.height * 0.01) {
    return fallbackCornerPoint(marker, thresholded.cols, thresholded.rows);
  }

  return {
    x: rect.x + sumX / count,
    y: rect.y + sumY / count
  };
};

const rectifyWithCornerMarkers = (
  cv: typeof window.cv,
  gray: CvMat,
  thresholded: CvMat
): PreprocessedSheet => {
  const width = thresholded.cols;
  const height = thresholded.rows;
  const orderedMarkers: CornerMarker[] = [
    defaultSheetTemplate.cornerMarkers.find((marker) => marker.id === "tl"),
    defaultSheetTemplate.cornerMarkers.find((marker) => marker.id === "tr"),
    defaultSheetTemplate.cornerMarkers.find((marker) => marker.id === "br"),
    defaultSheetTemplate.cornerMarkers.find((marker) => marker.id === "bl")
  ].filter((marker): marker is CornerMarker => Boolean(marker));

  if (orderedMarkers.length !== 4) {
    return { thresholded, warped: false };
  }

  const corners = orderedMarkers.map((marker) => detectCornerPoint(thresholded, marker));
  const src = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    corners.flatMap((corner) => [corner.x, corner.y])
  );
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    width - 1, 0,
    width - 1, height - 1,
    0, height - 1
  ]);
  const transform = cv.getPerspectiveTransform(src, dst);
  const warpedGray = new cv.Mat() as CvMat;
  cv.warpPerspective(
    gray,
    warpedGray,
    transform,
    new cv.Size(width, height),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT
  );
  const warpedBinary = new cv.Mat() as CvMat;
  cv.threshold(
    warpedGray,
    warpedBinary,
    0,
    255,
    cv.THRESH_BINARY_INV | cv.THRESH_OTSU
  );

  src.delete();
  dst.delete();
  transform.delete();
  warpedGray.delete();
  thresholded.delete();

  return {
    thresholded: warpedBinary,
    warped: true
  };
};

const toThresholdedMat = async (file: File): Promise<PreprocessedSheet> => {
  const cv = await loadOpenCv();
  await yieldToBrowser();
  const image = await loadImageElement(file);
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  const scale =
    longestSide > MAX_PROCESSING_DIMENSION
      ? MAX_PROCESSING_DIMENSION / longestSide
      : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to initialize canvas context.");
  }
  ctx.drawImage(image, 0, 0, width, height);
  await yieldToBrowser();

  const src = cv.imread(canvas);
  const gray = new cv.Mat() as CvMat;
  const blurred = new cv.Mat() as CvMat;
  const binary = new cv.Mat() as CvMat;
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  await yieldToBrowser();
  cv.GaussianBlur(gray, blurred, { width: 3, height: 3 }, 0, 0);
  cv.threshold(
    blurred,
    binary,
    0,
    255,
    cv.THRESH_BINARY_INV | cv.THRESH_OTSU
  );
  src.delete();
  blurred.delete();
  await yieldToBrowser();
  const rectified = rectifyWithCornerMarkers(cv, gray, binary);
  gray.delete();
  await yieldToBrowser();
  return rectified;
};

const scoreDigitColumns = (thresholded: CvMat, columns: { x: number; y: number; w: number; h: number }[][]) => {
  const shadeScores = columns.map((column) =>
    column.map((bubble) => regionShadeScore(thresholded, bubble))
  );
  const darknessThreshold = defaultSheetTemplate.scoring?.darknessThreshold ?? 0.28;
  const detected = shadeScores.map((scores) =>
    pickDigitByDominance(scores, { minTopScore: darknessThreshold }).detected
  );
  return { detected, shadeScores };
};

export const processSheetFile = async (file: File): Promise<OMRResultJson> => {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Image file is too large. Please upload an image smaller than 20MB.");
  }
  const preprocessed = await toThresholdedMat(file);
  const thresholded = preprocessed.thresholded;
  try {
    const studentId = scoreDigitColumns(thresholded, defaultSheetTemplate.studentId.columns);
    const examCode = scoreDigitColumns(thresholded, defaultSheetTemplate.examCode.columns);
    const examSetScores = computeChoiceScores(thresholded, defaultSheetTemplate.examSet.choices);
    const darknessThreshold = defaultSheetTemplate.scoring?.darknessThreshold ?? 0.28;
    const examSetDecision = pickSelections(examSetScores, darknessThreshold);
    const answers: OMRResultJson["answers"] = [];
    for (let index = 0; index < defaultSheetTemplate.answers.length; index += 1) {
      const item = defaultSheetTemplate.answers[index];
      answers.push(scoreAnswer(item.question, thresholded, item.choices));
      if (index > 0 && index % 12 === 0) {
        // Yield to the browser periodically to avoid long main-thread stalls.
        await yieldToBrowser();
      }
    }

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
        warped: preprocessed.warped,
        width: thresholded.cols,
        height: thresholded.rows
      }
    };
  } finally {
    thresholded.delete();
  }
};
