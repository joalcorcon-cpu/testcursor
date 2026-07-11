import type { OMRResultJson, OMRTemplate } from "@/types/omr";

type WorkerMessage =
  | { type: "progress"; stage: string }
  | { type: "result"; result: OMRResultJson }
  | { type: "error"; message: string };

const WORKER_TIMEOUT_MS = 60000;

export const processSheetFileInWorker = async (
  imageRgbaBuffer: ArrayBuffer,
  width: number,
  height: number,
  template: OMRTemplate,
  onProgress?: (stage: string) => void,
  signal?: AbortSignal
): Promise<OMRResultJson> => {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    throw new Error("Web Worker scanning is not supported in this environment.");
  }

  return await new Promise<OMRResultJson>((resolve, reject) => {
    const worker = new Worker("/omr-worker.js");

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      worker.terminate();
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Scan timed out. Please try a clearer or smaller image."));
    }, WORKER_TIMEOUT_MS);

    const handleAbort = () => {
      cleanup();
      reject(new Error("Scan cancelled."));
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort);

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const payload = event.data;
      if (!payload) {
        return;
      }
      if (payload.type === "progress") {
        onProgress?.(payload.stage);
        return;
      }
      if (payload.type === "error") {
        cleanup();
        reject(new Error(payload.message));
        return;
      }
      if (payload.type === "result") {
        cleanup();
        resolve(payload.result);
      }
    };

    worker.onerror = () => {
      cleanup();
      reject(new Error("Worker crashed while processing the scan."));
    };

    worker.postMessage(
      {
        type: "scan",
        imageRgbaBuffer,
        width,
        height,
        template
      },
      [imageRgbaBuffer]
    );
  });
};
