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

const pickSelections = (scores, minMarkThreshold = 0.28, ambiguityGap = 0.03) => {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const second = sorted[1];
  const selected = sorted
    .filter((entry) => entry[1] >= minMarkThreshold && top[1] - entry[1] <= ambiguityGap)
    .map((entry) => entry[0]);
  const confidence = clamp(top[1] - second[1], 0, 1);
  const ambiguous = selected.length !== 1;
  return {
    selected: ambiguous ? [] : selected,
    confidence,
    ambiguous
  };
};

const pickDigitByDominance = (
  scores,
  { minTopScore = 0.28, minGapToSecond = 0.025, minStdMultiplier = 1.2 } = {}
) => {
  if (!scores || scores.length === 0) {
    return { detected: "", confidence: 0 };
  }
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
    detected: isDominant ? top.index : "",
    confidence: clamp(top.score - second.score, 0, 1)
  };
};

const detectCornerPoint = (cv, gray, thresholded, marker, customSearchRegion, otsuThreshold) => {
  const searchRegion = customSearchRegion ?? expandMarkerRegion(marker, 4);
  const rect = normalizeRegion(searchRegion, thresholded.cols, thresholded.rows);
  const expectedX = (marker.x + marker.w / 2) * thresholded.cols - rect.x;
  const expectedY = (marker.y + marker.h / 2) * thresholded.rows - rect.y;
  if (customSearchRegion) {
    const roiThresholded = thresholded.roi(rect);
    let bestPoint = null;
    try {
      if (
        typeof cv.findContours === "function" &&
        typeof cv.contourArea === "function" &&
        typeof cv.boundingRect === "function" &&
        typeof cv.RETR_EXTERNAL === "number" &&
        typeof cv.CHAIN_APPROX_SIMPLE === "number"
      ) {
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        try {
          cv.findContours(
            roiThresholded,
            contours,
            hierarchy,
            cv.RETR_EXTERNAL,
            cv.CHAIN_APPROX_SIMPLE
          );
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
              const score = area - aspectPenalty * area * 0.8 - dist * 2;
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
      }
    } finally {
      roiThresholded.delete();
    }

    if (bestPoint) {
      return {
        x: bestPoint.x,
        y: bestPoint.y,
        found: true
      };
    }

    const roiGray = gray.roi(rect);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    try {
      for (let y = 0; y < rect.height; y += 1) {
        for (let x = 0; x < rect.width; x += 1) {
          const pixel = roiGray.ucharPtr(y, x)[0];
          if (pixel <= otsuThreshold) {
            count += 1;
            sumX += x;
            sumY += y;
          }
        }
      }
    } finally {
      roiGray.delete();
    }
    if (count < rect.width * rect.height * 0.01) {
      return {
        x: NaN,
        y: NaN,
        found: false
      };
    }
    return {
      x: rect.x + sumX / count,
      y: rect.y + sumY / count,
      found: true
    };
  }

  const roi = thresholded.roi(rect);

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
  const centroidX =
    Number.isFinite(snapshot.centroidX) && snapshot.centroidX >= 0
      ? Number(snapshot.centroidX)
      : null;
  const centroidY =
    Number.isFinite(snapshot.centroidY) && snapshot.centroidY >= 0
      ? Number(snapshot.centroidY)
      : null;
  return {
    width: Math.round(width),
    height: Math.round(height),
    grayscale: grayArray,
    centroidX,
    centroidY
  };
};

const quadrantRectForCorner = (cornerId, width, height) => {
  const quarterWidth = Math.max(1, Math.floor(width / 4));
  const quarterHeight = Math.max(1, Math.floor(height / 4));
  if (cornerId === "tl") {
    return { x: 0, y: 0, width: quarterWidth, height: quarterHeight };
  }
  if (cornerId === "tr") {
    return { x: width - quarterWidth, y: 0, width: quarterWidth, height: quarterHeight };
  }
  if (cornerId === "bl") {
    return { x: 0, y: height - quarterHeight, width: quarterWidth, height: quarterHeight };
  }
  return {
    x: width - quarterWidth,
    y: height - quarterHeight,
    width: quarterWidth,
    height: quarterHeight
  };
};

const detectCornerByTemplateMatch = (cv, gray, cornerId, snapshot, otsuThreshold) => {
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
    const matchX = quadrant.x + maxLoc.x;
    const matchY = quadrant.y + maxLoc.y;
    const sampleRect = new cv.Rect(matchX, matchY, normalized.width, normalized.height);
    const sampleRoi = gray.roi(sampleRect);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    try {
      for (let y = 0; y < normalized.height; y += 1) {
        for (let x = 0; x < normalized.width; x += 1) {
          const pixel = sampleRoi.ucharPtr(y, x)[0];
          if (pixel <= otsuThreshold) {
            count += 1;
            sumX += x;
            sumY += y;
          }
        }
      }
    } finally {
      sampleRoi.delete();
    }

    const matchThreshold = 0.3;
    const minDarkPixels = normalized.width * normalized.height * 0.004;
    if (count >= minDarkPixels) {
      return {
        x: matchX + sumX / count,
        y: matchY + sumY / count,
        found: maxVal >= matchThreshold,
        score: maxVal,
        searchRect: quadrant,
        matchRect: { x: matchX, y: matchY, width: normalized.width, height: normalized.height },
        usedSnapshotCentroid: false
      };
    }
    if (
      normalized.centroidX !== null &&
      normalized.centroidY !== null &&
      maxVal >= matchThreshold
    ) {
      return {
        x: matchX + normalized.centroidX,
        y: matchY + normalized.centroidY,
        found: true,
        score: maxVal,
        searchRect: quadrant,
        matchRect: { x: matchX, y: matchY, width: normalized.width, height: normalized.height },
        usedSnapshotCentroid: true
      };
    }
    return {
      x: NaN,
      y: NaN,
      found: false,
      score: maxVal,
      searchRect: quadrant,
      matchRect: { x: matchX, y: matchY, width: normalized.width, height: normalized.height },
      usedSnapshotCentroid: false
    };
  } finally {
    quadrantRoi.delete();
    templateMat.delete();
    result.delete();
  }
};

const inferMissingCornerByParallelogram = (pointsById) => {
  const tl = pointsById.tl;
  const tr = pointsById.tr;
  const br = pointsById.br;
  const bl = pointsById.bl;
  if (!tl && tr && br && bl) {
    return { id: "tl", point: { x: tr.x + bl.x - br.x, y: tr.y + bl.y - br.y } };
  }
  if (!tr && tl && br && bl) {
    return { id: "tr", point: { x: tl.x + br.x - bl.x, y: tl.y + br.y - bl.y } };
  }
  if (!br && tl && tr && bl) {
    return { id: "br", point: { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y } };
  }
  if (!bl && tl && tr && br) {
    return { id: "bl", point: { x: tl.x + br.x - tr.x, y: tl.y + br.y - tr.y } };
  }
  return null;
};

const inferMissingCornersBySimilarity = (pointsById, canonicalById) => {
  const ids = ["tl", "tr", "br", "bl"];
  const knownIds = ids.filter((id) => pointsById[id]);
  if (knownIds.length < 2) {
    return null;
  }

  let bestPair = null;
  for (let i = 0; i < knownIds.length; i += 1) {
    for (let j = i + 1; j < knownIds.length; j += 1) {
      const a = knownIds[i];
      const b = knownIds[j];
      const cA = canonicalById[a];
      const cB = canonicalById[b];
      const dist = Math.hypot(cB.x - cA.x, cB.y - cA.y);
      if (!bestPair || dist > bestPair.dist) {
        bestPair = { a, b, dist };
      }
    }
  }
  if (!bestPair || bestPair.dist < 1e-3) {
    return null;
  }

  const cA = canonicalById[bestPair.a];
  const cB = canonicalById[bestPair.b];
  const pA = pointsById[bestPair.a];
  const pB = pointsById[bestPair.b];
  if (!pA || !pB) {
    return null;
  }

  const vC = { x: cB.x - cA.x, y: cB.y - cA.y };
  const vP = { x: pB.x - pA.x, y: pB.y - pA.y };
  const denom = vC.x * vC.x + vC.y * vC.y;
  if (denom < 1e-6) {
    return null;
  }

  const coeffA = (vP.x * vC.x + vP.y * vC.y) / denom;
  const coeffB = (vP.y * vC.x - vP.x * vC.y) / denom;

  const inferred = {};
  for (const id of ids) {
    if (pointsById[id]) {
      continue;
    }
    const c = canonicalById[id];
    const dx = c.x - cA.x;
    const dy = c.y - cA.y;
    inferred[id] = {
      x: pA.x + coeffA * dx - coeffB * dy,
      y: pA.y + coeffB * dx + coeffA * dy
    };
  }
  return inferred;
};

const cornerAngleDegrees = (previousPoint, vertexPoint, nextPoint) => {
  const v1x = previousPoint.x - vertexPoint.x;
  const v1y = previousPoint.y - vertexPoint.y;
  const v2x = nextPoint.x - vertexPoint.x;
  const v2y = nextPoint.y - vertexPoint.y;
  const magnitude1 = Math.hypot(v1x, v1y);
  const magnitude2 = Math.hypot(v2x, v2y);
  if (magnitude1 <= 1e-6 || magnitude2 <= 1e-6) {
    return 0;
  }
  const cosine = clamp((v1x * v2x + v1y * v2y) / (magnitude1 * magnitude2), -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
};

const buildCornerAngleDiagnostics = (corners) => {
  if (!Array.isArray(corners) || corners.length !== 4) {
    return {
      angles: null,
      uneven: false
    };
  }
  const angles = {
    tl: cornerAngleDegrees(corners[3], corners[0], corners[1]),
    tr: cornerAngleDegrees(corners[0], corners[1], corners[2]),
    br: cornerAngleDegrees(corners[1], corners[2], corners[3]),
    bl: cornerAngleDegrees(corners[2], corners[3], corners[0])
  };
  const maxDeviation = Math.max(
    Math.abs(angles.tl - 90),
    Math.abs(angles.tr - 90),
    Math.abs(angles.br - 90),
    Math.abs(angles.bl - 90)
  );
  return {
    angles,
    uneven: maxDeviation > 12
  };
};

const scoreDigitColumns = (cv, thresholded, columns, darknessThreshold) => {
  const shadeScores = columns.map((column) =>
    column.map((bubble) => regionShadeScore(cv, thresholded, bubble))
  );
  const detected = shadeScores.map((scores) =>
    pickDigitByDominance(scores, { minTopScore: darknessThreshold }).detected
  );
  return { detected, shadeScores };
};

const scoreAnswer = (cv, thresholded, answerItem, darknessThreshold) => {
  const shadeScores = computeChoiceScores(cv, thresholded, answerItem.choices);
  const decision = pickSelections(shadeScores, darknessThreshold);
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
  const otsuThreshold = cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

  src.delete();
  blurred.delete();

  return { gray, binary, otsuThreshold };
};

const resolveSheetCorners = (cv, gray, thresholded, template, otsuThreshold) => {
  const orderedMarkers = [
    template.cornerMarkers.find((marker) => marker.id === "tl"),
    template.cornerMarkers.find((marker) => marker.id === "tr"),
    template.cornerMarkers.find((marker) => marker.id === "br"),
    template.cornerMarkers.find((marker) => marker.id === "bl")
  ].filter(Boolean);

  if (orderedMarkers.length !== 4) {
    return {
      valid: false,
      corners: [],
      debug: [],
      foundByDetectionCount: 0,
      foundAfterTriangulationCount: 0,
      triangulatedCount: 0
    };
  }

  const hasAllCornerSnapshots = orderedMarkers.every(
    (marker) => normalizeCornerSnapshot(template.cornerSnapshots?.[marker.id]) !== null
  );

  const cornerDetections = orderedMarkers.map((marker) => {
    if (hasAllCornerSnapshots) {
      const snapshotMatch = detectCornerByTemplateMatch(
        cv,
        gray,
        marker.id,
        template.cornerSnapshots?.[marker.id],
        otsuThreshold
      );
      if (
        snapshotMatch &&
        snapshotMatch.found &&
        Number.isFinite(snapshotMatch.x) &&
        Number.isFinite(snapshotMatch.y)
      ) {
        return {
          detection: snapshotMatch,
          debug: {
            id: marker.id,
            method: "snapshot-match",
            found: snapshotMatch.found,
            point: Number.isFinite(snapshotMatch.x) && Number.isFinite(snapshotMatch.y)
              ? { x: snapshotMatch.x, y: snapshotMatch.y }
              : null,
            searchRect: snapshotMatch.searchRect,
            matchRect: snapshotMatch.matchRect,
            score: snapshotMatch.score,
            usedSnapshotCentroid: snapshotMatch.usedSnapshotCentroid
          }
        };
      }

      const customSearchRegion = template.cornerSearchWindows?.[marker.id];
      const fallbackDetection = detectCornerPoint(
        cv,
        gray,
        thresholded,
        marker,
        customSearchRegion,
        otsuThreshold
      );
      return {
        detection: fallbackDetection,
        debug: {
          id: marker.id,
          method: "snapshot-match+centroid-fallback",
          found: fallbackDetection.found,
          point:
            Number.isFinite(fallbackDetection.x) && Number.isFinite(fallbackDetection.y)
              ? { x: fallbackDetection.x, y: fallbackDetection.y }
              : null,
          searchRect: customSearchRegion
            ? normalizeRegion(customSearchRegion, thresholded.cols, thresholded.rows)
            : snapshotMatch?.searchRect,
          matchRect: snapshotMatch?.matchRect,
          score: snapshotMatch?.score,
          usedSnapshotCentroid: snapshotMatch?.usedSnapshotCentroid
        }
      };
    }

    const customSearchRegion = template.cornerSearchWindows?.[marker.id];
    if (customSearchRegion) {
      const detection = detectCornerPoint(
        cv,
        gray,
        thresholded,
        marker,
        customSearchRegion,
        otsuThreshold
      );
      return {
        detection,
        debug: {
          id: marker.id,
          method: "manual-region-centroid",
          found: detection.found,
          point:
            Number.isFinite(detection.x) && Number.isFinite(detection.y)
              ? { x: detection.x, y: detection.y }
              : null,
          searchRect: normalizeRegion(customSearchRegion, thresholded.cols, thresholded.rows)
        }
      };
    }

    const cornerSnapshot = template.cornerSnapshots?.[marker.id];
    const snapshotMatch = detectCornerByTemplateMatch(
      cv,
      gray,
      marker.id,
      cornerSnapshot,
      otsuThreshold
    );
    if (snapshotMatch?.found) {
      return {
        detection: { x: snapshotMatch.x, y: snapshotMatch.y, found: true },
        debug: {
          id: marker.id,
          method: "snapshot-match",
          found: true,
          point: { x: snapshotMatch.x, y: snapshotMatch.y },
          searchRect: snapshotMatch.searchRect,
          matchRect: snapshotMatch.matchRect,
          score: snapshotMatch.score,
          usedSnapshotCentroid: snapshotMatch.usedSnapshotCentroid
        }
      };
    }
    const detection = detectCornerPoint(
      cv,
      gray,
      thresholded,
      marker,
      undefined,
      otsuThreshold
    );
    return {
      detection,
      debug: {
        id: marker.id,
        method: "expanded-region-contour",
        found: detection.found,
        point:
          Number.isFinite(detection.x) && Number.isFinite(detection.y)
            ? { x: detection.x, y: detection.y }
            : null,
        searchRect: normalizeRegion(
          expandMarkerRegion(marker, 4),
          thresholded.cols,
          thresholded.rows
        )
      }
    };
  });
  const pointsById = {};
  for (const entry of cornerDetections) {
    if (
      entry.detection.found &&
      Number.isFinite(entry.detection.x) &&
      Number.isFinite(entry.detection.y)
    ) {
      pointsById[entry.debug.id] = { x: entry.detection.x, y: entry.detection.y };
    }
  }

  const canonicalById = {};
  for (const marker of orderedMarkers) {
    canonicalById[marker.id] = {
      x: (marker.x + marker.w / 2) * thresholded.cols,
      y: (marker.y + marker.h / 2) * thresholded.rows
    };
  }

  const initialFoundCount = Object.keys(pointsById).length;
  if (initialFoundCount < 4) {
    const inferredFromThree = inferMissingCornerByParallelogram(pointsById);
    if (inferredFromThree) {
      pointsById[inferredFromThree.id] = inferredFromThree.point;
    }
  }
  if (Object.keys(pointsById).length < 4) {
    const inferredBySimilarity = inferMissingCornersBySimilarity(pointsById, canonicalById);
    if (inferredBySimilarity) {
      Object.assign(pointsById, inferredBySimilarity);
    }
  }

  const debugById = new Map(cornerDetections.map((entry) => [entry.debug.id, entry.debug]));
  for (const marker of orderedMarkers) {
    const id = marker.id;
    const existingDebug = debugById.get(id);
    if (!existingDebug) {
      continue;
    }
    if (!existingDebug.found && pointsById[id]) {
      existingDebug.found = true;
      existingDebug.method = `${existingDebug.method}+triangulated-rectangle`;
      existingDebug.point = { x: pointsById[id].x, y: pointsById[id].y };
    }
  }

  if (Object.keys(pointsById).length < 4) {
    workerLog("Corner detection incomplete after triangulation", {
      foundBeforeTriangulation: initialFoundCount,
      foundAfterTriangulation: Object.keys(pointsById).length
    });
    return {
      valid: false,
      corners: [],
      debug: orderedMarkers.map((marker) => debugById.get(marker.id)),
      foundByDetectionCount: initialFoundCount,
      foundAfterTriangulationCount: Object.keys(pointsById).length,
      triangulatedCount: Math.max(0, Object.keys(pointsById).length - initialFoundCount)
    };
  }
  const corners = orderedMarkers.map((marker) => ({
    x: pointsById[marker.id].x,
    y: pointsById[marker.id].y
  }));
  const angleDiagnostics = buildCornerAngleDiagnostics(corners);
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
    return {
      valid: false,
      corners: [],
      debug: cornerDetections.map((entry) => entry.debug),
      foundByDetectionCount: initialFoundCount,
      foundAfterTriangulationCount: Object.keys(pointsById).length,
      triangulatedCount: Math.max(0, Object.keys(pointsById).length - initialFoundCount)
    };
  }

  return {
    valid: true,
    corners,
    debug: orderedMarkers.map((marker) => debugById.get(marker.id)),
    foundByDetectionCount: initialFoundCount,
    foundAfterTriangulationCount: Object.keys(pointsById).length,
    triangulatedCount: Math.max(0, Object.keys(pointsById).length - initialFoundCount),
    cornerAngles: angleDiagnostics.angles,
    cornerUneven: angleDiagnostics.uneven
  };
};

const rectifySheet = (cv, gray, thresholded, template, otsuThreshold) => {
  const cornerResolution = resolveSheetCorners(cv, gray, thresholded, template, otsuThreshold);
  if (!cornerResolution.valid) {
    return {
      thresholded,
      warped: false,
      cornerDebug: cornerResolution.debug,
      cornerFoundCount: cornerResolution.foundByDetectionCount,
      cornerUsedCount: cornerResolution.foundAfterTriangulationCount,
      cornerTriangulatedCount: cornerResolution.triangulatedCount,
      cornerAngles: cornerResolution.cornerAngles,
      cornerUneven: cornerResolution.cornerUneven
    };
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

  return {
    thresholded: warpedBinary,
    warped: true,
    cornerDebug: cornerResolution.debug,
    cornerFoundCount: cornerResolution.foundByDetectionCount,
    cornerUsedCount: cornerResolution.foundAfterTriangulationCount,
    cornerTriangulatedCount: cornerResolution.triangulatedCount,
    cornerAngles: cornerResolution.cornerAngles,
    cornerUneven: cornerResolution.cornerUneven
  };
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

  const { gray, binary, otsuThreshold } = makeThresholdedSheet(cv, imageRgbaBuffer, width, height);
  try {
    const cornerResolution = resolveSheetCorners(cv, gray, binary, template, otsuThreshold);
    if (!cornerResolution.valid) {
      const fallbackCopy = imageRgbaBuffer.slice(0);
      return {
        rgbaBuffer: fallbackCopy,
        width,
        height,
        warped: false,
        cornerDebug: cornerResolution.debug
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
      warped: true,
      cornerDebug: cornerResolution.debug
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
  const { gray, binary, otsuThreshold } = makeThresholdedSheet(cv, imageRgbaBuffer, width, height);

  postProgress(requestId, "Aligning sheet...");
  const rectified = rectifySheet(cv, gray, binary, template, otsuThreshold);
  gray.delete();

  const thresholded = rectified.thresholded;
  try {
    const darknessThreshold = clamp(
      Number(template?.scoring?.darknessThreshold ?? 0.28),
      0,
      1
    );
    postProgress(requestId, "Scoring ID and exam fields...");
    const studentId = scoreDigitColumns(cv, thresholded, template.studentId.columns, darknessThreshold);
    const examCode = scoreDigitColumns(cv, thresholded, template.examCode.columns, darknessThreshold);
    const examSetScores = computeChoiceScores(cv, thresholded, template.examSet.choices);
    const examSetDecision = pickSelections(examSetScores, darknessThreshold);

    const answers = [];
    postProgress(requestId, "Scoring answers...");
    for (let index = 0; index < template.answers.length; index += 1) {
      answers.push(scoreAnswer(cv, thresholded, template.answers[index], darknessThreshold));
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
        height: thresholded.rows,
        cornerFoundCount: rectified.cornerFoundCount,
        cornerUsedCount: rectified.cornerUsedCount,
        cornerTriangulatedCount: rectified.cornerTriangulatedCount,
        cornerAngles: rectified.cornerAngles,
        cornerUneven: rectified.cornerUneven
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
