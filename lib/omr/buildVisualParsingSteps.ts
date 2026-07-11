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
  detectedX: number;
  detectedY: number;
  usedFallback: boolean;
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
  thresholdMap: Uint8ClampedArray,
  width: number,
  height: number,
  marker: CornerMarker,
  customSearchRegion?: BubbleRegion
) => {
  const searchRect = normalizeRect(customSearchRegion ?? expandMarker(marker, 4), width, height);
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = searchRect.y; y < searchRect.y + searchRect.h; y += 1) {
    for (let x = searchRect.x; x < searchRect.x + searchRect.w; x += 1) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        continue;
      }
      const idx = y * width + x;
      if (thresholdMap[idx] > 0) {
        sumX += x;
        sumY += y;
        count += 1;
      }
    }
  }

  if (count < searchRect.w * searchRect.h * 0.01) {
    return {
      searchRect,
      point: {
        x: searchRect.x + searchRect.w / 2,
        y: searchRect.y + searchRect.h / 2
      },
      usedFallback: true
    };
  }

  return {
    searchRect,
    point: {
      x: sumX / count,
      y: sumY / count
    },
    usedFallback: false
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
  const threshold = otsuThreshold(grayscale);
  const thresholdRgba = new Uint8ClampedArray(normalizedImage.data.length);
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
  const thresholdImage = new ImageData(
    thresholdRgba,
    normalizedImage.width,
    normalizedImage.height
  );
  const normalizedImageDataUrl = toDataUrl(normalizedImage);
  const cornerDetections = template.cornerMarkers.map((marker) =>
    detectCornerCentroid(
      thresholdMask,
      normalizedImage.width,
      normalizedImage.height,
      marker,
      template.cornerSearchWindows?.[marker.id]
    )
  );
  const cornerWindows: CornerWindowVisual[] = cornerDetections.map((detection, index) => ({
    id: template.cornerMarkers[index].id,
    x: detection.searchRect.x / normalizedImage.width,
    y: detection.searchRect.y / normalizedImage.height,
    w: detection.searchRect.w / normalizedImage.width,
    h: detection.searchRect.h / normalizedImage.height,
    detectedX: detection.point.x / normalizedImage.width,
    detectedY: detection.point.y / normalizedImage.height,
    usedFallback: detection.usedFallback
  }));
  onStage?.("Applying perspective transform...");
  let rectified = { image: normalizedImage, warped: false };
  try {
    const rectifiedPreview = await buildRectifiedPreviewInWorker(
      prepared.rgbaBuffer.slice(0),
      prepared.width,
      prepared.height,
      template
    );
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
  const rectifiedImageDataUrl = toDataUrl(rectified.image);

  onStage?.("Drawing region overlays...");
  const roiBoxes = deriveRoiBoxesFromTemplate(template);

  const cornerOverlayUrl = drawDataUrl(normalizedImage, (ctx) => {
    ctx.lineWidth = 3;
    for (const detection of cornerDetections) {
      ctx.strokeStyle = "#00ff95";
      ctx.strokeRect(
        detection.searchRect.x,
        detection.searchRect.y,
        detection.searchRect.w,
        detection.searchRect.h
      );
      ctx.fillStyle = detection.usedFallback ? "#ff9f43" : "#00ff95";
      ctx.beginPath();
      ctx.arc(detection.point.x, detection.point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  const roiOverlayUrl = drawDataUrl(rectified.image, (ctx) => {
    const drawLabel = (label: string, region: BubbleRegion, color: string) => {
      const rect = normalizeRect(region, rectified.image.width, rectified.image.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = color;
      ctx.font = "16px Arial";
      ctx.fillText(label, rect.x + 6, rect.y + 18);
    };
    const roiColorMap: Record<string, string> = {
      studentId: "#55d6ff",
      examCode: "#ff9f43",
      examSet: "#7bed9f",
      answersCol1: "#ff6b81",
      answersCol2: "#ffa502",
      answersCol3: "#70a1ff"
    };
    const roiLabelMap: Record<string, string> = {
      studentId: "Student ID",
      examCode: "Exam Code",
      examSet: "Exam Set",
      answersCol1: "Answers 1-35",
      answersCol2: "Answers 36-70",
      answersCol3: "Answers 71-100"
    };
    for (const box of roiBoxes) {
      drawLabel(
        roiLabelMap[box.id] ?? box.id,
        { x: box.x, y: box.y, w: box.w, h: box.h },
        roiColorMap[box.id] ?? "#ffffff"
      );
    }
  });

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
      title: "Step 1: Corner marker detection",
      description:
        "Green boxes are expanded search windows. Dots are detected marker centers (orange means fallback center).",
      imageDataUrl: cornerOverlayUrl,
      baseImageDataUrl: normalizedImageDataUrl,
      cornerWindows
    },
    {
      id: "rectified",
      title: "Step 2: Perspective transformed sheet",
      description: rectified.warped
        ? "Sheet was straightened using detected corner positions."
        : "Perspective transform fallback used original normalized image.",
      imageDataUrl: rectifiedImageDataUrl
    },
    {
      id: "regions",
      title: "Step 3: Region-of-interest map",
      description:
        "Student ID, Exam Code, Exam Set, and 3 answer columns highlighted for extraction on transformed sheet.",
      imageDataUrl: roiOverlayUrl,
      baseImageDataUrl: rectifiedImageDataUrl,
      roiBoxes
    }
  ];
};
