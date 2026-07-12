import { bundledCornerSnapshotSources } from "@/lib/templates/bundledReferences";
import type { CornerMarker, CornerSnapshot } from "@/types/omr";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const otsuThreshold = (grayscale: Uint8ClampedArray): number => {
  const histogram = new Array<number>(256).fill(0);
  for (const value of grayscale) {
    histogram[value] += 1;
  }
  let weightedTotal = 0;
  for (let i = 0; i < 256; i += 1) {
    weightedTotal += i * histogram[i];
  }
  let backgroundWeight = 0;
  let backgroundWeighted = 0;
  let best = 127;
  let maxVariance = -1;
  const total = grayscale.length;
  for (let i = 0; i < 256; i += 1) {
    backgroundWeight += histogram[i];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundWeighted += i * histogram[i];
    const meanBg = backgroundWeighted / backgroundWeight;
    const meanFg = (weightedTotal - backgroundWeighted) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBg - meanFg) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      best = i;
    }
  }
  return best;
};

const imageToSnapshot = async (
  id: CornerMarker["id"],
  src: string
): Promise<CornerSnapshot | null> => {
  const image = new Image();
  image.src = src;
  await image.decode();
  const width = Math.max(4, image.naturalWidth || image.width);
  const height = Math.max(4, image.naturalHeight || image.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const grayscale = new Uint8ClampedArray(width * height);
  for (let i = 0; i < grayscale.length; i += 1) {
    const index = i * 4;
    grayscale[i] = clamp(
      Math.round(rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114),
      0,
      255
    );
  }
  const threshold = otsuThreshold(grayscale);
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (grayscale[y * width + x] <= threshold) {
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }

  return {
    id,
    width,
    height,
    grayscale: Array.from(grayscale),
    centroidX: count > 0 ? sumX / count : undefined,
    centroidY: count > 0 ? sumY / count : undefined
  };
};

export const loadBundledCornerSnapshots = async (): Promise<
  Partial<Record<CornerMarker["id"], CornerSnapshot>>
> => {
  const ids: CornerMarker["id"][] = ["tl", "tr", "br", "bl"];
  const result: Partial<Record<CornerMarker["id"], CornerSnapshot>> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const snapshot = await imageToSnapshot(id, bundledCornerSnapshotSources[id]);
        if (snapshot) {
          result[id] = snapshot;
        }
      } catch {
        // Non-blocking: app can still use geometric fallback detection.
      }
    })
  );
  return result;
};
