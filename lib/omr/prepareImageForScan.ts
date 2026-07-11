const IMAGE_DECODE_TIMEOUT_MS = 12000;
const MAX_NORMALIZED_DIMENSION = 1600;

interface PreparedScanImage {
  buffer: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
};

const decodeViaImageElement = async (file: File): Promise<HTMLImageElement> => {
  const url = URL.createObjectURL(file);
  try {
    return await withTimeout(
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to decode image."));
        image.src = url;
      }),
      IMAGE_DECODE_TIMEOUT_MS,
      "Image decode timed out. Please upload another image."
    );
  } finally {
    URL.revokeObjectURL(url);
  }
};

const fileToBitmap = async (file: File): Promise<ImageBitmap> => {
  if (typeof createImageBitmap === "function") {
    try {
      return await withTimeout(
        createImageBitmap(file),
        IMAGE_DECODE_TIMEOUT_MS,
        "Image decode timed out. Please upload another image."
      );
    } catch {
      // Fallback to HTMLImageElement path below.
    }
  }

  const image = await decodeViaImageElement(file);
  return await withTimeout(
    createImageBitmap(image),
    IMAGE_DECODE_TIMEOUT_MS,
    "Image decode timed out. Please upload another image."
  );
};

export const prepareImageForScan = async (file: File): Promise<PreparedScanImage> => {
  const bitmap = await fileToBitmap(file);
  try {
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale =
      longestSide > MAX_NORMALIZED_DIMENSION
        ? MAX_NORMALIZED_DIMENSION / longestSide
        : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to prepare canvas for image normalization.");
    }
    context.drawImage(bitmap, 0, 0, width, height);

    const normalizedBlob = await withTimeout(
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Unable to convert image for scanning."));
            return;
          }
          resolve(blob);
        }, "image/jpeg", 0.92);
      }),
      IMAGE_DECODE_TIMEOUT_MS,
      "Image normalization timed out. Please upload another image."
    );

    return {
      buffer: await normalizedBlob.arrayBuffer(),
      mimeType: "image/jpeg",
      width,
      height
    };
  } finally {
    bitmap.close();
  }
};
