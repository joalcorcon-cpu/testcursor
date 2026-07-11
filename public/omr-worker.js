import cvFactory from "/opencv-worker-runtime.js";

const OPENCV_READY_TIMEOUT_MS = 180000;
const MAX_RGBA_BYTES = 25 * 1024 * 1024;

let cvReadyPromise = null;
let lastInitError = "";
const currentStageByRequest = new Map();
const workerLog = (message, details) => {
  if (details === undefined) {
    console.info(`[OMR WorkerThread] ${message}`);
    return;
  }
  console.info(`[OMR WorkerThread] ${message}`, details);
};

const loadOpenCv = async () => {
  if (cvReadyPromise) {
    return cvReadyPromise;
  }

  workerLog("Initializing OpenCV runtime");
  cvReadyPromise = Promise.race([
    cvFactory({
      printErr: (...args) => {
        lastInitError = args
          .map((value) => (typeof value === "string" ? value : String(value)))
          .join(" ");
      }
    }),
    new Promise((_, reject) => {
      setTimeout(() => {
        const suffix = lastInitError ? ` Last error: ${lastInitError}` : "";
        reject(new Error(`OpenCV runtime initialization timed out in worker.${suffix}`));
      }, OPENCV_READY_TIMEOUT_MS);
    })
  ]).catch((error) => {
    workerLog("OpenCV init failed", error instanceof Error ? error.message : String(error));
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

const expandMarkerRegion = (marker, factor = 4) => {
  const centerX = marker.x + marker.w / 2;
  const centerY = marker.y + marker.h / 2;
  const width = marker.w * factor;
  const height = marker.h * factor;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    w: width,
    h: height
  };
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

const detectCornerPoint = (cv, thresholded, marker, customSearchRegion) => {
  const searchRegion = customSearchRegion ?? expandMarkerRegion(marker, 4);
  const rect = normalizeRegion(searchRegion, thresholded.cols, thresholded.rows);
  const roi = thresholded.roi(rect);
  const expectedX = (marker.x + marker.w / 2) * thresholded.cols - rect.x;
  const expectedY = (marker.y + marker.h / 2) * thresholded.rows - rect.y;

  if (
    typeof cv.findContours === "function" &&
    typeof cv.contourArea === "function" &&
    typeof cv.boundingRect === "function" &&
    typeof cv.RETR_EXTERNAL === "number" &&
    typeof cv.CHAIN_APPROX_SIMPLE === "number"
  ) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let bestPoint = null;
    try {
      cv.findContours(roi, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        try {
          const area = cv.contourArea(contour, false);
          if (area < rect.width * rect.height * 0.002) {
            continue;
          }
          const bounds = cv.boundingRect(contour);
          const aspect = bounds.width / Math.max(bounds.height, 1);
          const aspectPenalty = Math.abs(1 - aspect);
          const centerX = bounds.x + bounds.width / 2;
          const centerY = bounds.y + bounds.height / 2;
          const dist = Math.hypot(centerX - expectedX, centerY - expectedY);
          const score = area - dist * 3 - aspectPenalty * area * 0.7;
          if (!bestPoint || score > bestPoint.score) {
            bestPoint = {
              score,
              x: rect.x + centerX,
              y: rect.y + centerY
            };
          }
        } finally {
          contour.delete();
        }
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }

    if (bestPoint) {
      roi.delete();
      return { x: bestPoint.x, y: bestPoint.y, found: true };
    }
  }

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
    if (customSearchRegion) {
      return {
        x: NaN,
        y: NaN,
        found: false
      };
    }
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      found: false
    };
  }

  return {
    x: rect.x + sumX / count,
    y: rect.y + sumY / count,
    found: true
  };
};

const normalizeCornerSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const width = Number(snapshot.width);
  const height = Number(snapshot.height);
  const grayscale = Array.isArray(snapshot.grayscale) ? snapshot.grayscale : null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 4 || height < 4 || !grayscale) {
    return null;
  }
  if (grayscale.length !== Math.round(width) * Math.round(height)) {
    return null;
  }
  const grayArray = Uint8ClampedArray.from(grayscale.map((value) => clamp(Number(value) || 0, 0, 255)));
  return {
    width: Math.round(width),
    height: Math.round(height),
    grayscale: grayArray
  };
};

const quadrantRectForCorner = (cornerId, width, height) => {
  const halfWidth = Math.max(1, Math.floor(width / 2));
  const halfHeight = Math.max(1, Math.floor(height / 2));
  if (cornerId === "tl") {
    return { x: 0, y: 0, width: halfWidth, height: halfHeight };
  }
  if (cornerId === "tr") {
    return { x: width - halfWidth, y: 0, width: halfWidth, height: halfHeight };
  }
  if (cornerId === "bl") {
    return { x: 0, y: height - halfHeight, width: halfWidth, height: halfHeight };
  }
  return { x: width - halfWidth, y: height - halfHeight, width: halfWidth, height: halfHeight };
};

const detectCornerByTemplateMatch = (cv, gray, cornerId, snapshot) => {
  const normalized = normalizeCornerSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  const quadrant = quadrantRectForCorner(cornerId, gray.cols, gray.rows);
  if (normalized.width >= quadrant.width || normalized.height >= quadrant.height) {
    return null;
  }

  const quadrantRoi = gray.roi(
    new cv.Rect(quadrant.x, quadrant.y, quadrant.width, quadrant.height)
  );
  const templateMat = cv.matFromArray(
    normalized.height,
    normalized.width,
    cv.CV_8UC1,
    Array.from(normalized.grayscale)
  );
  const result = new cv.Mat();

  try {
    cv.matchTemplate(quadrantRoi, templateMat, result, cv.TM_CCOEFF_NORMED);
    const { maxVal, maxLoc } = cv.minMaxLoc(result);
    return {
      x: quadrant.x + maxLoc.x + normalized.width / 2,
      y: quadrant.y + maxLoc.y + normalized.height / 2,
      found: maxVal >= 0.35,
      score: maxVal
    };
  } finally {
    quadrantRoi.delete();
    templateMat.delete();
    result.delete();
  }
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

const resolveSheetCorners = (cv, gray, thresholded, template) => {
  const orderedMarkers = [
    template.cornerMarkers.find((marker) => marker.id === "tl"),
    template.cornerMarkers.find((marker) => marker.id === "tr"),
    template.cornerMarkers.find((marker) => marker.id === "br"),
    template.cornerMarkers.find((marker) => marker.id === "bl")
  ].filter(Boolean);

  if (orderedMarkers.length !== 4) {
    return { valid: false, corners: [] };
  }

  const cornerDetections = orderedMarkers.map((marker) => {
    const cornerSnapshot = template.cornerSnapshots?.[marker.id];
    const snapshotMatch = detectCornerByTemplateMatch(cv, gray, marker.id, cornerSnapshot);
    if (snapshotMatch?.found) {
      return { x: snapshotMatch.x, y: snapshotMatch.y, found: true };
    }
    return detectCornerPoint(cv, thresholded, marker, template.cornerSearchWindows?.[marker.id]);
  });
  const foundCount = cornerDetections.filter((corner) => corner.found).length;
  if (foundCount < 4) {
    workerLog("Corner detection incomplete", { foundCount });
    return { valid: false, corners: [] };
  }
  const corners = cornerDetections.map((corner) => ({ x: corner.x, y: corner.y }));
  const cornerLayoutIsValid =
    corners[0].x < corners[1].x &&
    corners[3].x < corners[2].x &&
    corners[0].y < corners[3].y &&
    corners[1].y < corners[2].y;
  const polygonArea =
    Math.abs(
      corners[0].x * corners[1].y +
        corners[1].x * corners[2].y +
        corners[2].x * corners[3].y +
        corners[3].x * corners[0].y -
        (corners[1].x * corners[0].y +
          corners[2].x * corners[1].y +
          corners[3].x * corners[2].y +
          corners[0].x * corners[3].y)
    ) / 2;
  if (!cornerLayoutIsValid || polygonArea < thresholded.cols * thresholded.rows * 0.25) {
    return { valid: false, corners: [] };
  }

  return { valid: true, corners };
};

const rectifySheet = (cv, gray, thresholded, template) => {
  const cornerResolution = resolveSheetCorners(cv, gray, thresholded, template);
  if (!cornerResolution.valid) {
    return { thresholded, warped: false };
  }

  const srcPoints = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    cornerResolution.corners.flatMap((corner) => [corner.x, corner.y])
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

const buildRectifiedPreview = async ({ requestId, imageRgbaBuffer, width, height, template }) => {
  if (!(imageRgbaBuffer instanceof ArrayBuffer)) {
    throw new Error("Invalid preview payload.");
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("Invalid preview image dimensions.");
  }
  if (imageRgbaBuffer.byteLength > MAX_RGBA_BYTES) {
    throw new Error("Normalized image payload is too large to preview.");
  }

  currentStageByRequest.set(requestId, "Preparing rectified preview...");
  const cv = await loadOpenCv();

  const { gray, binary } = makeThresholdedSheet(cv, imageRgbaBuffer, width, height);
  try {
    const cornerResolution = resolveSheetCorners(cv, gray, binary, template);
    if (!cornerResolution.valid) {
      const fallbackCopy = imageRgbaBuffer.slice(0);
      return {
        rgbaBuffer: fallbackCopy,
        width,
        height,
        warped: false
      };
    }

    const rgba = new Uint8ClampedArray(imageRgbaBuffer);
    let sourceImageData;
    if (typeof ImageData === "function") {
      sourceImageData = new ImageData(rgba, width, height);
    } else {
      const sourceCanvas = new OffscreenCanvas(width, height);
      const sourceContext = sourceCanvas.getContext("2d");
      if (!sourceContext) {
        throw new Error("Unable to create image data for preview.");
      }
      sourceImageData = sourceContext.createImageData(width, height);
      sourceImageData.data.set(rgba);
    }
    const sourceMat = cv.matFromImageData(sourceImageData);
    const srcPoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      cornerResolution.corners.flatMap((corner) => [corner.x, corner.y])
    );
    const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      width - 1,
      0,
      width - 1,
      height - 1,
      0,
      height - 1
    ]);
    const transform = cv.getPerspectiveTransform(srcPoints, dstPoints);
    const warpedRgba = new cv.Mat();
    cv.warpPerspective(
      sourceMat,
      warpedRgba,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT
    );

    const rgbaOut = new Uint8ClampedArray(warpedRgba.data.length);
    rgbaOut.set(warpedRgba.data);

    sourceMat.delete();
    srcPoints.delete();
    dstPoints.delete();
    transform.delete();
    warpedRgba.delete();

    return {
      rgbaBuffer: rgbaOut.buffer,
      width,
      height,
      warped: true
    };
  } finally {
    gray.delete();
    binary.delete();
  }
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
  workerLog("OpenCV runtime ready");

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

  if (data.type !== "scan" && data.type !== "rectify-preview") {
    return;
  }

  const requestId = data.requestId;
  currentStageByRequest.set(requestId, "worker-start");
  workerLog("Received request", {
    requestId,
    type: data.type,
    width: data.width,
    height: data.height
  });
  try {
    if (data.type === "scan") {
      const result = await runScan(data);
      self.postMessage({ type: "result", requestId, result });
      return;
    }

    const preview = await buildRectifiedPreview(data);
    self.postMessage(
      {
        type: "preview-result",
        requestId,
        preview
      },
      [preview.rgbaBuffer]
    );
  } catch (error) {
    const currentStage = currentStageByRequest.get(requestId) || "unknown";
    const message = error instanceof Error ? error.message : "Scan failed in worker.";
    const stackTop =
      error instanceof Error && typeof error.stack === "string"
        ? error.stack.split("\n").slice(0, 2).join(" | ")
        : "";
    if (data.type === "scan") {
      self.postMessage({
        type: "error",
        requestId,
        message,
        stage: currentStage,
        stack: stackTop
      });
    } else {
      self.postMessage({
        type: "preview-error",
        requestId,
        message,
        stage: currentStage,
        stack: stackTop
      });
    }
  } finally {
    currentStageByRequest.delete(requestId);
  }
};
