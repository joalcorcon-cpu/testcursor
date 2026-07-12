import { prepareImageForScan } from "@/lib/omr/prepareImageForScan";
import { buildRectifiedPreviewInWorker } from "@/lib/omr/processSheetInWorker";
import {
  deriveRoiBoxesFromTemplate,
  type RoiBoxVisual
} from "@/lib/omr/roiCalibration";
import type { BubbleRegion, CornerMarker, OMRTemplate } from "@/types/omr";

export interface CornerWindowVisual {
  id: CornerMarker["id"];
  x: number;
  y: number;
  w: number;
  h: number;
  detectedX: number | null;
  detectedY: number | null;
  hasCentroid: boolean;
}

export interface VisualParseStep {
  id: string;
  title: string;
  description: string;
  imageDataUrl: string;
  baseImageDataUrl?: string;
  cornerWindows?: CornerWindowVisual[];
  roiBoxes?: RoiBoxVisual[];
}

const toCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const imageDataFromRgba = (rgbaBuffer: ArrayBuffer, width: number, height: number) =>
  new ImageData(new Uint8ClampedArray(rgbaBuffer), width, height);

const toDataUrl = (imageData: ImageData): string => {
  const canvas = toCanvas(imageData.width, imageData.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to render parse step image.");
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
};

const drawDataUrl = (baseImage: ImageData, draw: (ctx: CanvasRenderingContext2D) => void) => {
  const canvas = toCanvas(baseImage.width, baseImage.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to render parse overlay.");
  }
  context.putImageData(baseImage, 0, 0);
  draw(context);
  return canvas.toDataURL("image/png");
};

const normalizeRect = (region: BubbleRegion, width: number, height: number) => ({
  x: Math.round(region.x * width),
  y: Math.round(region.y * height),
  w: Math.max(1, Math.round(region.w * width)),
  h: Math.max(1, Math.round(region.h * height))
});

const expandMarker = (marker: CornerMarker, factor = 4): BubbleRegion => {
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

const detectCornerCentroid = (
  grayscale: Uint8ClampedArray,
  threshold: number,
  width: number,
  height: number,
  marker: CornerMarker,
  customSearchRegion?: BubbleRegion
) => {
  const searchRect = normalizeRect(customSearchRegion ?? expandMarker(marker, 4), width, height);
  const regionWidth = searchRect.w;
  const regionHeight = searchRect.h;
  const visited = new Uint8Array(regionWidth * regionHeight);
  const indexOf = (x: number, y: number) => y * regionWidth + x;
  const expectedX = Math.round((marker.x + marker.w / 2) * width) - searchRect.x;
  const expectedY = Math.round((marker.y + marker.h / 2) * height) - searchRect.y;

  let best:
    | {
        count: number;
        sumX: number;
        sumY: number;
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        score: number;
      }
    | null = null;

  for (let startY = 0; startY < regionHeight; startY += 1) {
    for (let startX = 0; startX < regionWidth; startX += 1) {
      const localIndex = indexOf(startX, startY);
      if (visited[localIndex]) {
        continue;
      }
      const globalX = searchRect.x + startX;
      const globalY = searchRect.y + startY;
      const globalIndex = globalY * width + globalX;
      if (grayscale[globalIndex] > threshold) {
        visited[localIndex] = 1;
        continue;
      }

      const queueX = [startX];
      const queueY = [startY];
      visited[localIndex] = 1;
      let cursor = 0;
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = startX;
      let minY = startY;
      let maxX = startX;
      let maxY = startY;

      while (cursor < queueX.length) {
        const x = queueX[cursor];
        const y = queueY[cursor];
        cursor += 1;

        count += 1;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1]
        ] as const;
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= regionWidth || ny < 0 || ny >= regionHeight) {
            continue;
          }
          const nLocal = indexOf(nx, ny);
          if (visited[nLocal]) {
            continue;
          }
          visited[nLocal] = 1;
          const nGlobal = (searchRect.y + ny) * width + (searchRect.x + nx);
          if (grayscale[nGlobal] <= threshold) {
            queueX.push(nx);
            queueY.push(ny);
          }
        }
      }

      const boxW = Math.max(1, maxX - minX + 1);
      const boxH = Math.max(1, maxY - minY + 1);
      const aspect = boxW / boxH;
      const aspectPenalty = Math.abs(1 - aspect);
      const centerX = sumX / count;
      const centerY = sumY / count;
      const distancePenalty = Math.hypot(centerX - expectedX, centerY - expectedY);
      const score = count - aspectPenalty * count * 0.7 - distancePenalty * 0.8;

      if (!best || score > best.score) {
        best = {
          count,
          sumX,
          sumY,
          minX,
          minY,
          maxX,
          maxY,
          score
        };
      }
    }
  }

  const minimumPixels = searchRect.w * searchRect.h * 0.004;
  const bestCount = best ? best.count : 0;
  if (!best || best.count < minimumPixels) {
    return {
      searchRect,
      point: null,
      darkPixelCount: bestCount
    };
  }

  return {
    searchRect,
    point: {
      x: searchRect.x + best.sumX / best.count,
      y: searchRect.y + best.sumY / best.count
    },
    darkPixelCount: best.count
  };
};

const grayscaleFromRgba = (rgba: Uint8ClampedArray): Uint8ClampedArray => {
  const grayscale = new Uint8ClampedArray(rgba.length / 4);
  for (let index = 0; index < rgba.length; index += 4) {
    const gray = Math.round(
      rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114
    );
    grayscale[index / 4] = gray;
  }
  return grayscale;
};

const otsuThreshold = (grayscale: Uint8ClampedArray): number => {
  const histogram = new Array<number>(256).fill(0);
  for (const value of grayscale) {
    histogram[value] += 1;
  }

  let sum = 0;
  for (let index = 0; index < 256; index += 1) {
    sum += index * histogram[index];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;
  const total = grayscale.length;

  for (let index = 0; index < 256; index += 1) {
    weightBackground += histogram[index];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += index * histogram[index];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = index;
    }
  }

  return threshold;
};

const buildThresholdArtifacts = (imageData: ImageData) => {
  const grayscale = grayscaleFromRgba(imageData.data);
  const threshold = otsuThreshold(grayscale);
  const thresholdRgba = new Uint8ClampedArray(imageData.data.length);
  const thresholdMask = new Uint8ClampedArray(grayscale.length);
  for (let index = 0; index < grayscale.length; index += 1) {
    const rgbaIndex = index * 4;
    const value = grayscale[index] <= threshold ? 255 : 0;
    thresholdMask[index] = value;
    thresholdRgba[rgbaIndex] = value;
    thresholdRgba[rgbaIndex + 1] = value;
    thresholdRgba[rgbaIndex + 2] = value;
    thresholdRgba[rgbaIndex + 3] = 255;
  }
  return {
    grayscale,
    threshold,
    thresholdMask,
    thresholdImage: new ImageData(thresholdRgba, imageData.width, imageData.height)
  };
};

const buildDarkPixelImage = (grayscale: Uint8ClampedArray, width: number, height: number, threshold: number) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < grayscale.length; index += 1) {
    const pixel = grayscale[index] <= threshold ? 0 : 255;
    const rgbaIndex = index * 4;
    rgba[rgbaIndex] = pixel;
    rgba[rgbaIndex + 1] = pixel;
    rgba[rgbaIndex + 2] = pixel;
    rgba[rgbaIndex + 3] = 255;
  }
  return new ImageData(rgba, width, height);
};

const shadeScoreFromMask = (
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  region: BubbleRegion
) => {
  const rect = normalizeRect(region, width, height);
  let dark = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        continue;
      }
      if (mask[y * width + x] > 0) {
        dark += 1;
      }
    }
  }
  const total = rect.w * rect.h;
  return total > 0 ? dark / total : 0;
};

const roiLabelMap: Record<string, string> = {
  studentId: "ID",
  examCode: "CODE",
  examSet: "SET",
  answersCol1: "A1",
  answersCol2: "A2",
  answersCol3: "A3"
};

const buildRoiAndReadAreaArtifacts = (
  rectifiedImage: ImageData,
  template: OMRTemplate,
  onStage?: (stage: string) => void
) => {
  const roiBoxes = deriveRoiBoxesFromTemplate(template);
  const drawGrid = (
    ctx: CanvasRenderingContext2D,
    region: BubbleRegion,
    cols: number,
    rows: number
  ) => {
    const rect = normalizeRect(region, rectifiedImage.width, rectifiedImage.height);
    ctx.strokeStyle = "rgba(0,255,149,0.5)";
    ctx.lineWidth = 1.1;
    for (let col = 1; col < cols; col += 1) {
      const x = rect.x + (rect.w * col) / cols;
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
      ctx.stroke();
    }
    for (let row = 1; row < rows; row += 1) {
      const y = rect.y + (rect.h * row) / rows;
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
      ctx.stroke();
    }
  };

  const roiOverlayUrl = drawDataUrl(rectifiedImage, (ctx) => {
    const drawLabel = (label: string, region: BubbleRegion) => {
      const rect = normalizeRect(region, rectifiedImage.width, rectifiedImage.height);
      ctx.strokeStyle = "#00ff95";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "#00ff95";
      ctx.font = "14px Arial";
      ctx.fillText(label, rect.x + 5, rect.y + 17);
    };

    const gridById: Record<string, { cols: number; rows: number }> = {
      studentId: { rows: template.studentId.digits, cols: template.studentId.bubbleRows },
      examCode: { rows: template.examCode.digits, cols: template.examCode.bubbleRows },
      examSet: { rows: 1, cols: 4 },
      answersCol1: { rows: 35, cols: 4 },
      answersCol2: { rows: 35, cols: 4 },
      answersCol3: { rows: 30, cols: 4 }
    };

    for (const box of roiBoxes) {
      const spec = gridById[box.id];
      if (spec) {
        drawGrid(ctx, box, spec.cols, spec.rows);
      }
      drawLabel(roiLabelMap[box.id] ?? box.id, { x: box.x, y: box.y, w: box.w, h: box.h });
    }
  });

  onStage?.("Rendering detailed read-area map...");
  const rectifiedThreshold = buildThresholdArtifacts(rectifiedImage);
  const readAreasOverlayUrl = drawDataUrl(rectifiedImage, (ctx) => {
    const drawBubble = (region: BubbleRegion, activeThreshold = 0.18) => {
      const shade = shadeScoreFromMask(
        rectifiedThreshold.thresholdMask,
        rectifiedImage.width,
        rectifiedImage.height,
        region
      );
      const rect = normalizeRect(region, rectifiedImage.width, rectifiedImage.height);
      const active = shade >= activeThreshold;
      ctx.lineWidth = 1;
      ctx.strokeStyle = active ? "#12ff8b" : "rgba(255,255,255,0.28)";
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      if (active) {
        ctx.fillStyle = "rgba(18,255,139,0.2)";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
    };

    const drawOuter = (label: string, region: BubbleRegion, color: string) => {
      const rect = normalizeRect(region, rectifiedImage.width, rectifiedImage.height);
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.lineWidth = 5;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = color;
      ctx.font = "12px Arial";
      ctx.fillText(label, rect.x + 5, rect.y - 8);
      const corners: Array<[number, number]> = [
        [rect.x, rect.y],
        [rect.x + rect.w, rect.y],
        [rect.x + rect.w, rect.y + rect.h],
        [rect.x, rect.y + rect.h]
      ];
      for (const [x, y] of corners) {
        ctx.beginPath();
        ctx.fillStyle = "rgba(0,0,0,0.8)";
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const gridById: Record<string, { cols: number; rows: number }> = {
      studentId: { rows: template.studentId.digits, cols: template.studentId.bubbleRows },
      examCode: { rows: template.examCode.digits, cols: template.examCode.bubbleRows },
      examSet: { rows: 1, cols: 4 },
      answersCol1: { rows: 35, cols: 4 },
      answersCol2: { rows: 35, cols: 4 },
      answersCol3: { rows: 30, cols: 4 }
    };
    for (const box of roiBoxes) {
      const spec = gridById[box.id];
      if (spec) {
        drawGrid(ctx, box, spec.cols, spec.rows);
      }
    }

    for (const row of template.studentId.columns) {
      for (const bubble of row) {
        drawBubble(bubble);
      }
    }
    for (const row of template.examCode.columns) {
      for (const bubble of row) {
        drawBubble(bubble);
      }
    }
    for (const bubble of Object.values(template.examSet.choices)) {
      drawBubble(bubble);
    }
    for (const answer of template.answers) {
      drawBubble(answer.choices.A);
      drawBubble(answer.choices.B);
      drawBubble(answer.choices.C);
      drawBubble(answer.choices.D);
      if (answer.question % 5 === 1) {
        const labelRect = normalizeRect(answer.choices.A, rectifiedImage.width, rectifiedImage.height);
        ctx.fillStyle = "rgba(255,255,255,0.72)";
        ctx.font = "10px Arial";
        ctx.fillText(`${answer.question}`, Math.max(2, labelRect.x - 14), labelRect.y + 10);
      }
    }

    for (const box of roiBoxes) {
      drawOuter(
        roiLabelMap[box.id] ?? box.id,
        { x: box.x, y: box.y, w: box.w, h: box.h },
        "#00ff95"
      );
    }
  });

  return { roiBoxes, roiOverlayUrl, readAreasOverlayUrl };
};

const dataUrlToImageData = async (dataUrl: string): Promise<ImageData> => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const canvas = toCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to decode rectified image for ROI rebuild.");
  }
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
};

export const buildRoiReadAreaStepsFromRectifiedDataUrl = async (
  rectifiedImageDataUrl: string,
  template: OMRTemplate,
  onStage?: (stage: string) => void
): Promise<{ regionsStep: VisualParseStep; readAreasStep: VisualParseStep }> => {
  onStage?.("Reusing rectified image for ROI update...");
  const rectifiedImage = await dataUrlToImageData(rectifiedImageDataUrl);
  const { roiBoxes, roiOverlayUrl, readAreasOverlayUrl } = buildRoiAndReadAreaArtifacts(
    rectifiedImage,
    template,
    onStage
  );
  return {
    regionsStep: {
      id: "regions",
      title: "Step 4: Region-of-interest map",
      description:
        "Student ID, Exam Code, Exam Set, and 3 answer columns highlighted for extraction on transformed sheet.",
      imageDataUrl: roiOverlayUrl,
      baseImageDataUrl: rectifiedImageDataUrl,
      roiBoxes
    },
    readAreasStep: {
      id: "read-areas",
      title: "Step 5: Detailed OMR read areas",
      description:
        "Detailed bubble-by-bubble map of every area used during OMR scoring. ROI outlines and labels mirror the Step 4 draggable boxes; green bubble highlights indicate darker detected marks.",
      imageDataUrl: readAreasOverlayUrl
    }
  };
};

export const buildVisualParsingSteps = async (
  file: File,
  template: OMRTemplate,
  onStage?: (stage: string) => void
): Promise<VisualParseStep[]> => {
  onStage?.("Decoding and normalizing image...");
  const prepared = await prepareImageForScan(file);
  const normalizedImage = imageDataFromRgba(
    prepared.rgbaBuffer,
    prepared.width,
    prepared.height
  );

  onStage?.("Building grayscale visualization...");
  const grayscale = grayscaleFromRgba(normalizedImage.data);
  const grayscaleRgba = new Uint8ClampedArray(normalizedImage.data.length);
  for (let index = 0; index < grayscale.length; index += 1) {
    const gray = grayscale[index];
    const rgbaIndex = index * 4;
    grayscaleRgba[rgbaIndex] = gray;
    grayscaleRgba[rgbaIndex + 1] = gray;
    grayscaleRgba[rgbaIndex + 2] = gray;
    grayscaleRgba[rgbaIndex + 3] = 255;
  }
  const grayscaleImage = new ImageData(
    grayscaleRgba,
    normalizedImage.width,
    normalizedImage.height
  );

  onStage?.("Computing threshold map...");
  const thresholdArtifacts = buildThresholdArtifacts(normalizedImage);
  const threshold = thresholdArtifacts.threshold;
  const thresholdImage = thresholdArtifacts.thresholdImage;
  const darkPixelImage = buildDarkPixelImage(
    thresholdArtifacts.grayscale,
    normalizedImage.width,
    normalizedImage.height,
    threshold
  );
  const normalizedImageDataUrl = toDataUrl(normalizedImage);
  const initialCornerDetections = template.cornerMarkers.map((marker) =>
    detectCornerCentroid(
      thresholdArtifacts.grayscale,
      threshold,
      normalizedImage.width,
      normalizedImage.height,
      marker,
      template.cornerSearchWindows?.[marker.id]
    )
  );
  const cornerWindows: CornerWindowVisual[] = initialCornerDetections.map((detection, index) => ({
    id: template.cornerMarkers[index].id,
    x: detection.searchRect.x / normalizedImage.width,
    y: detection.searchRect.y / normalizedImage.height,
    w: detection.searchRect.w / normalizedImage.width,
    h: detection.searchRect.h / normalizedImage.height,
    detectedX: detection.point ? detection.point.x / normalizedImage.width : null,
    detectedY: detection.point ? detection.point.y / normalizedImage.height : null,
    hasCentroid: Boolean(detection.point)
  }));

  const cornerWindowOverlayUrl = drawDataUrl(normalizedImage, (ctx) => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#00ff95";
    for (const detection of initialCornerDetections) {
      ctx.strokeRect(
        detection.searchRect.x,
        detection.searchRect.y,
        detection.searchRect.w,
        detection.searchRect.h
      );
    }
  });

  onStage?.("Applying perspective transform...");
  let cornerDebug:
    | Array<{
        id: CornerMarker["id"];
        method: string;
        found: boolean;
        point: { x: number; y: number } | null;
        searchRect?: { x: number; y: number; width: number; height: number };
        matchRect?: { x: number; y: number; width: number; height: number };
        score?: number;
        usedSnapshotCentroid?: boolean;
      }>
    | undefined;
  let rectified = { image: normalizedImage, warped: false };
  try {
    const rectifiedPreview = await buildRectifiedPreviewInWorker(
      prepared.rgbaBuffer.slice(0),
      prepared.width,
      prepared.height,
      template
    );
    cornerDebug = rectifiedPreview.cornerDebug;
    rectified = {
      image: imageDataFromRgba(
        rectifiedPreview.rgbaBuffer,
        rectifiedPreview.width,
        rectifiedPreview.height
      ),
      warped: rectifiedPreview.warped
    };
  } catch {
    rectified = { image: normalizedImage, warped: false };
  }
  const fallbackCentroidById = new Map(
    template.cornerMarkers.map((marker, idx) => [marker.id, initialCornerDetections[idx]])
  );
  const centroidOverlayDetections = template.cornerMarkers.map((marker) => {
    const debug = cornerDebug?.find((entry) => entry.id === marker.id);
    if (debug) {
      const fallback = fallbackCentroidById.get(marker.id);
      return {
        id: marker.id,
        searchRect: debug.searchRect
          ? {
              x: debug.searchRect.x,
              y: debug.searchRect.y,
              w: debug.searchRect.width,
              h: debug.searchRect.height
            }
          : fallback?.searchRect ?? normalizeRect(expandMarker(marker, 4), normalizedImage.width, normalizedImage.height),
        point: debug.point,
        found: debug.found,
        matchRect: debug.matchRect,
        method: debug.method,
        usedSnapshotCentroid: debug.usedSnapshotCentroid
      };
    }
    const fallback = fallbackCentroidById.get(marker.id);
    return {
      id: marker.id,
      searchRect:
        fallback?.searchRect ?? normalizeRect(expandMarker(marker, 4), normalizedImage.width, normalizedImage.height),
      point: fallback?.point ?? null,
      found: Boolean(fallback?.point),
      method: "visual-fallback"
    };
  });
  const cornerCentroidFound = centroidOverlayDetections.filter((detection) => detection.found).length;
  const cornerCentroidOverlayUrl = drawDataUrl(darkPixelImage, (ctx) => {
    ctx.lineWidth = 2;
    for (const detection of centroidOverlayDetections) {
      ctx.strokeStyle = "#00ff95";
      ctx.strokeRect(
        detection.searchRect.x,
        detection.searchRect.y,
        detection.searchRect.w,
        detection.searchRect.h
      );
      if (detection.matchRect) {
        ctx.strokeStyle = "#ffd166";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
          detection.matchRect.x,
          detection.matchRect.y,
          detection.matchRect.width,
          detection.matchRect.height
        );
      }
      if (detection.point) {
        ctx.fillStyle = detection.usedSnapshotCentroid ? "#ffa94d" : "#00ff95";
        ctx.beginPath();
        ctx.arc(detection.point.x, detection.point.y, 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = "#ff4d4f";
        const centerX = detection.searchRect.x + detection.searchRect.w / 2;
        const centerY = detection.searchRect.y + detection.searchRect.h / 2;
        ctx.beginPath();
        ctx.moveTo(centerX - 6, centerY - 6);
        ctx.lineTo(centerX + 6, centerY + 6);
        ctx.moveTo(centerX + 6, centerY - 6);
        ctx.lineTo(centerX - 6, centerY + 6);
        ctx.stroke();
      }
    }
  });
  const rectifiedImageDataUrl = toDataUrl(rectified.image);

  onStage?.("Drawing region overlays...");
  const { roiBoxes, roiOverlayUrl, readAreasOverlayUrl } = buildRoiAndReadAreaArtifacts(
    rectified.image,
    template,
    onStage
  );

  onStage?.("Compiling visual step list...");
  return [
    {
      id: "normalized",
      title: "Step 1: Normalized image",
      description:
        "Uploaded image normalized to scanner resolution for consistent parsing.",
      imageDataUrl: normalizedImageDataUrl
    },
    {
      id: "grayscale",
      title: "Step 2: Grayscale conversion",
      description:
        "Image converted to grayscale before thresholding to isolate bubble marks.",
      imageDataUrl: toDataUrl(grayscaleImage)
    },
    {
      id: "threshold",
      title: "Step 3: Otsu threshold map",
      description: `Binary thresholding (Otsu=${threshold}) highlights dark marks and printed bubbles.`,
      imageDataUrl: toDataUrl(thresholdImage)
    },
    {
      id: "corners",
      title: "Step 1: Corner search regions",
      description:
        "Drag-adjusted corner search windows. These exact regions are used for centroid lookup.",
      imageDataUrl: cornerWindowOverlayUrl,
      baseImageDataUrl: normalizedImageDataUrl,
      cornerWindows
    },
    {
      id: "corner-centroids",
      title: "Step 2: Corner centroid detection",
      description: `Centroids are computed from bundled corner snapshots with centroid fallback (${cornerCentroidFound}/4 found). Green centroid = detected crop centroid, orange = snapshot-centroid offset fallback, yellow box = matchTemplate crop.`,
      imageDataUrl: cornerCentroidOverlayUrl
    },
    {
      id: "rectified",
      title: "Step 3: Perspective transformed sheet",
      description: rectified.warped
        ? "Sheet was straightened using detected corner positions."
        : "Perspective transform fallback used original normalized image.",
      imageDataUrl: rectifiedImageDataUrl
    },
    {
      id: "regions",
      title: "Step 4: Region-of-interest map",
      description:
        "Student ID, Exam Code, Exam Set, and 3 answer columns highlighted for extraction on transformed sheet.",
      imageDataUrl: roiOverlayUrl,
      baseImageDataUrl: rectifiedImageDataUrl,
      roiBoxes
    },
    {
      id: "read-areas",
      title: "Step 5: Detailed OMR read areas",
      description:
        "Detailed bubble-by-bubble map of every area used during OMR scoring. ROI outlines and labels mirror the Step 4 draggable boxes; green bubble highlights indicate darker detected marks.",
      imageDataUrl: readAreasOverlayUrl
    }
  ];
};
