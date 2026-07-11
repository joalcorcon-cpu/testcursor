import type { OMRResultJson, OMRTemplate } from "@/types/omr";

type WorkerMessage =
  | { type: "ready" }
  | { type: "init-error"; message: string }
  | { type: "progress"; requestId: number; stage: string }
  | { type: "result"; requestId: number; result: OMRResultJson }
  | { type: "error"; requestId: number; message: string; stage?: string; stack?: string };

const WORKER_TIMEOUT_MS = 180000;

interface PendingScan {
  resolve: (result: OMRResultJson) => void;
  reject: (error: Error) => void;
  onProgress?: (stage: string) => void;
  lastStage: string;
  timeoutId: number;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

let sharedWorker: Worker | null = null;
let workerReadyPromise: Promise<void> | null = null;
let requestSeq = 1;
const pendingScans = new Map<number, PendingScan>();
const logWorkerDebug = (message: string, details?: unknown) => {
  if (details === undefined) {
    console.info(`[OMR Worker] ${message}`);
    return;
  }
  console.info(`[OMR Worker] ${message}`, details);
};

const teardownWorker = (error?: Error) => {
  if (sharedWorker) {
    sharedWorker.terminate();
  }
  sharedWorker = null;
  workerReadyPromise = null;

  if (pendingScans.size > 0) {
    logWorkerDebug("Tearing down worker with pending scans", { pending: pendingScans.size });
    for (const [requestId, pending] of pendingScans.entries()) {
      window.clearTimeout(pending.timeoutId);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener("abort", pending.abortHandler);
      }
      pending.reject(error ?? new Error("Worker terminated unexpectedly."));
      pendingScans.delete(requestId);
    }
  }
};

const ensureWorkerReady = async (): Promise<Worker> => {
  if (sharedWorker && workerReadyPromise) {
    await workerReadyPromise;
    return sharedWorker;
  }

  const worker = new Worker("/omr-worker.js", { type: "module" });
  sharedWorker = worker;
  logWorkerDebug("Created module worker");

  workerReadyPromise = new Promise<void>((resolve, reject) => {
    const initTimeoutId = window.setTimeout(() => {
      const initError = new Error("Worker initialization timed out.");
      teardownWorker(initError);
      reject(initError);
    }, 240000);

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const payload = event.data;
      if (!payload) {
        return;
      }

      if (payload.type === "ready") {
        logWorkerDebug("Worker runtime ready");
        window.clearTimeout(initTimeoutId);
        resolve();
        return;
      }

      if (payload.type === "init-error") {
        logWorkerDebug("Worker init-error", payload.message);
        window.clearTimeout(initTimeoutId);
        const initError = new Error(payload.message);
        teardownWorker(initError);
        reject(initError);
        return;
      }

      const pending = pendingScans.get(payload.requestId);
      if (!pending) {
        return;
      }

      if (payload.type === "progress") {
        logWorkerDebug(`Scan #${payload.requestId} stage`, payload.stage);
        pending.lastStage = payload.stage;
        pending.onProgress?.(payload.stage);
        return;
      }

      window.clearTimeout(pending.timeoutId);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener("abort", pending.abortHandler);
      }
      pendingScans.delete(payload.requestId);

      if (payload.type === "result") {
        logWorkerDebug(`Scan #${payload.requestId} completed`);
        pending.resolve(payload.result);
        return;
      }

      const stagePrefix = payload.stage ? `[${payload.stage}] ` : "";
      const stackSuffix = payload.stack ? ` (${payload.stack})` : "";
      logWorkerDebug(`Scan #${payload.requestId} failed`, {
        stage: payload.stage,
        message: payload.message,
        stack: payload.stack
      });
      pending.reject(new Error(`${stagePrefix}${payload.message}${stackSuffix}`));
    };

    worker.onerror = (event) => {
      window.clearTimeout(initTimeoutId);
      const location = `${event.filename ?? "worker"}:${event.lineno ?? "?"}:${event.colno ?? "?"}`;
      logWorkerDebug("Worker crashed", { location, message: event.message });
      const error = new Error(
        `Worker crashed while processing the scan (${location}): ${event.message}`
      );
      teardownWorker(error);
      reject(error);
    };

    worker.onmessageerror = () => {
      window.clearTimeout(initTimeoutId);
      logWorkerDebug("Worker message deserialization failed");
      const error = new Error("Worker message deserialization failed.");
      teardownWorker(error);
      reject(error);
    };
  });

  worker.postMessage({ type: "init" });
  logWorkerDebug("Posted init request");
  await workerReadyPromise;
  return worker;
};

export const warmupOmrWorker = async (): Promise<void> => {
  await ensureWorkerReady();
};

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

  const worker = await ensureWorkerReady();
  const requestId = requestSeq;
  requestSeq += 1;
  logWorkerDebug(`Dispatching scan #${requestId}`, { width, height });

  return await new Promise<OMRResultJson>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      const pending = pendingScans.get(requestId);
      if (!pending) {
        return;
      }
      pendingScans.delete(requestId);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener("abort", pending.abortHandler);
      }
      reject(
        new Error(
          `Scan timed out at stage "${pending.lastStage}". Please try a clearer or smaller image.`
        )
      );
      // Force-reset worker after timeout to avoid stale stuck runtime state.
      teardownWorker(new Error("Worker timed out during scan."));
    }, WORKER_TIMEOUT_MS);

    const handleAbort = () => {
      const pending = pendingScans.get(requestId);
      if (!pending) {
        return;
      }
      window.clearTimeout(timeoutId);
      pendingScans.delete(requestId);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener("abort", pending.abortHandler);
      }
      reject(new Error("Scan cancelled."));
      teardownWorker(new Error("Scan cancelled."));
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort);
    pendingScans.set(requestId, {
      resolve,
      reject,
      onProgress,
      lastStage: "queued",
      timeoutId,
      signal,
      abortHandler: handleAbort
    });

    worker.postMessage(
      {
        type: "scan",
        requestId,
        imageRgbaBuffer,
        width,
        height,
        template
      },
      [imageRgbaBuffer]
    );
  });
};
