const OPENCV_SCRIPT_URL = "/opencv.js";
const OPENCV_READY_TIMEOUT_MS = 60000;
const MAX_RGBA_BYTES = 25 * 1024 * 1024;

let cvReadyPromise = null;
const currentStageByRequest = new Map();

const isCvReady = () =>
  Boolean(self.cv && typeof self.cv.Mat === "function" && typeof self.cv.matFromImageData === "function");

const loadOpenCv = async () => {
  if (cvReadyPromise) {
    return cvReadyPromise;
  }

  cvReadyPromise = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const rejectTimeout = () => {
      reject(new Error("OpenCV runtime initialization timed out in worker."));
    };

    const pollReady = () => {
      if (isCvReady()) {
        resolve(self.cv);
        return;
      }
      if (Date.now() - startedAt > OPENCV_READY_TIMEOUT_MS) {
        rejectTimeout();
        return;
      }
      setTimeout(pollReady, 100);
    };

    try {
      importScripts(OPENCV_SCRIPT_URL);
    } catch (error) {
      reject(new Error("Unable to load OpenCV.js in worker."));
      return;
    }

    if (isCvReady()) {
      resolve(self.cv);
      return;
    }

    const cvAny = self.cv;
    if (cvAny && typeof cvAny === "object") {
      const previous = cvAny.onRuntimeInitialized;
      cvAny.onRuntimeInitialized = () => {
        if (typeof previous === "function") {
          previous();
        }
        if (isCvReady()) {
          resolve(self.cv);
        }
      };
    }
    pollReady();
  }).catch((error) => {
    cvReadyPromise = null;
    throw error;
  });

  return cvReadyPromise;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeRegion = (region, width, height) => {
  const x = clamp(Math.round(region.x * width), 0, width - 1);
  const y = clamp(Math.round(region.y * height), 0, height - 1);
  const w = clamp(Math.round(region.w * width), 1, width - x);
  const h = clamp(Math.round(region.h * height), 1, height - y);
  return { x, y, width: w, height: h };
};

const regionShadeScore = (cv, thresholded, region) => {
  const rect = normalizeRegion(region, thresholded.cols, thresholded.rows);
  const roi = thresholded.roi(rect);
  const ink = cv.countNonZero(roi);
  roi.delete();
  const total = rect.width * rect.height;
  return total > 0 ? ink / total : 0;
};

const computeChoiceScores = (cv, thresholded, choices) => ({
  A: regionShadeScore(cv, thresholded, choices.A),
  B: regionShadeScore(cv, thresholded, choices.B),
  C: regionShadeScore(cv, thresholded, choices.C),
  D: regionShadeScore(cv, thresholded, choices.D)
});

const pickSelections = (scores, minMarkThreshold = 0.18, ambiguityGap = 0.03) => {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const second = sorted[1];
  const selected = sorted
    .filter((entry) => entry[1] >= minMarkThreshold && top[1] - entry[1] <= ambiguityGap)
    .map((entry) => entry[0]);
  const confidence = clamp(top[1] - second[1], 0, 1);
  return {
    selected,
    confidence,
    ambiguous: selected.length !== 1
  };
};

const detectCornerPoint = (thresholded, marker) => {
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
    return {
      x: (marker.x + marker.w / 2) * thresholded.cols,
      y: (marker.y + marker.h / 2) * thresholded.rows
    };
  }

  return {
    x: rect.x + sumX / count,
    y: rect.y + sumY / count
  };
};

const scoreDigitColumns = (cv, thresholded, columns) => {
  const shadeScores = columns.map((column) =>
    column.map((bubble) => regionShadeScore(cv, thresholded, bubble))
  );
  const detected = shadeScores.map((scores) => {
    let bestIndex = 0;
    let bestScore = -1;
    for (let index = 0; index < scores.length; index += 1) {
      if (scores[index] > bestScore) {
        bestScore = scores[index];
        bestIndex = index;
      }
    }
    return bestIndex;
  });
  return { detected, shadeScores };
};

const scoreAnswer = (cv, thresholded, answerItem) => {
  const shadeScores = computeChoiceScores(cv, thresholded, answerItem.choices);
  const decision = pickSelections(shadeScores);
  return {
    q: answerItem.question,
    selected: decision.selected,
    shadeScores,
    confidence: decision.confidence,
    ambiguous: decision.ambiguous
  };
};

const makeThresholdedSheet = (cv, imageRgbaBuffer, width, height) => {
  const rgba = new Uint8ClampedArray(imageRgbaBuffer);
  let imageData;
  if (typeof ImageData === "function") {
    imageData = new ImageData(rgba, width, height);
  } else {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create image data for preprocessing.");
    }
    imageData = context.createImageData(width, height);
    imageData.data.set(rgba);
  }
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const binary = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0);
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

  src.delete();
  blurred.delete();

  return { gray, binary };
};

const rectifySheet = (cv, gray, thresholded, template) => {
  const orderedMarkers = [
    template.cornerMarkers.find((marker) => marker.id === "tl"),
    template.cornerMarkers.find((marker) => marker.id === "tr"),
    template.cornerMarkers.find((marker) => marker.id === "br"),
    template.cornerMarkers.find((marker) => marker.id === "bl")
  ].filter(Boolean);

  if (orderedMarkers.length !== 4) {
    return { thresholded, warped: false };
  }

  const corners = orderedMarkers.map((marker) => detectCornerPoint(thresholded, marker));
  const srcPoints = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    corners.flatMap((corner) => [corner.x, corner.y])
  );
  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    thresholded.cols - 1,
    0,
    thresholded.cols - 1,
    thresholded.rows - 1,
    0,
    thresholded.rows - 1
  ]);

  const transform = cv.getPerspectiveTransform(srcPoints, dstPoints);
  const warpedGray = new cv.Mat();
  cv.warpPerspective(
    gray,
    warpedGray,
    transform,
    new cv.Size(thresholded.cols, thresholded.rows),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT
  );

  const warpedBinary = new cv.Mat();
  cv.threshold(warpedGray, warpedBinary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

  srcPoints.delete();
  dstPoints.delete();
  transform.delete();
  warpedGray.delete();
  thresholded.delete();

  return { thresholded: warpedBinary, warped: true };
};

const postProgress = (requestId, stage) => {
  currentStageByRequest.set(requestId, stage);
  self.postMessage({ type: "progress", requestId, stage });
};

const runScan = async ({ requestId, imageRgbaBuffer, width, height, template }) => {
  if (!(imageRgbaBuffer instanceof ArrayBuffer)) {
    throw new Error("Invalid scan payload.");
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("Invalid image dimensions.");
  }
  if (imageRgbaBuffer.byteLength > MAX_RGBA_BYTES) {
    throw new Error("Normalized image payload is too large to process.");
  }

  postProgress(requestId, "Loading OpenCV runtime...");
  const cv = await loadOpenCv();

  postProgress(requestId, "Preprocessing image...");
  const { gray, binary } = makeThresholdedSheet(cv, imageRgbaBuffer, width, height);

  postProgress(requestId, "Aligning sheet...");
  const rectified = rectifySheet(cv, gray, binary, template);
  gray.delete();

  const thresholded = rectified.thresholded;
  try {
    postProgress(requestId, "Scoring ID and exam fields...");
    const studentId = scoreDigitColumns(cv, thresholded, template.studentId.columns);
    const examCode = scoreDigitColumns(cv, thresholded, template.examCode.columns);
    const examSetScores = computeChoiceScores(cv, thresholded, template.examSet.choices);
    const examSetDecision = pickSelections(examSetScores);

    const answers = [];
    postProgress(requestId, "Scoring answers...");
    for (let index = 0; index < template.answers.length; index += 1) {
      answers.push(scoreAnswer(cv, thresholded, template.answers[index]));
      if ((index + 1) % 20 === 0) {
        postProgress(requestId, `Scoring answers (${index + 1}/${template.answers.length})...`);
      }
    }

    return {
      templateId: template.id,
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
        warped: rectified.warped,
        width: thresholded.cols,
        height: thresholded.rows
      }
    };
  } finally {
    thresholded.delete();
  }
};

self.onmessage = async (event) => {
  const { data } = event;
  if (!data || !data.type) {
    return;
  }

  if (data.type === "init") {
    try {
      await loadOpenCv();
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({
        type: "init-error",
        message:
          error instanceof Error ? error.message : "Unable to initialize OpenCV runtime in worker."
      });
    }
    return;
  }

  if (data.type !== "scan") {
    return;
  }

  const requestId = data.requestId;
  currentStageByRequest.set(requestId, "worker-start");
  try {
    const result = await runScan(data);
    self.postMessage({ type: "result", requestId, result });
  } catch (error) {
    const currentStage = currentStageByRequest.get(requestId) || "unknown";
    const message = error instanceof Error ? error.message : "Scan failed in worker.";
    const stackTop =
      error instanceof Error && typeof error.stack === "string"
        ? error.stack.split("\n").slice(0, 2).join(" | ")
        : "";
    self.postMessage({
      type: "error",
      requestId,
      message,
      stage: currentStage,
      stack: stackTop
    });
  } finally {
    currentStageByRequest.delete(requestId);
  }
};
