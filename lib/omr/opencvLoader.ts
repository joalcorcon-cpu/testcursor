declare global {
  interface Window {
    cv: {
      Mat: new () => CvMat;
      Size: new (width: number, height: number) => { width: number; height: number };
      imread: (canvas: HTMLCanvasElement) => CvMat;
      matFromArray: (
        rows: number,
        cols: number,
        type: number,
        array: number[]
      ) => CvMat;
      cvtColor: (src: CvMat, dst: CvMat, code: number) => void;
      GaussianBlur: (
        src: CvMat,
        dst: CvMat,
        ksize: { width: number; height: number },
        sigmaX: number,
        sigmaY: number,
        borderType?: number
      ) => void;
      adaptiveThreshold: (
        src: CvMat,
        dst: CvMat,
        maxValue: number,
        adaptiveMethod: number,
        thresholdType: number,
        blockSize: number,
        c: number
      ) => void;
      threshold: (
        src: CvMat,
        dst: CvMat,
        thresh: number,
        maxVal: number,
        thresholdType: number
      ) => number;
      getPerspectiveTransform: (src: CvMat, dst: CvMat) => CvMat;
      warpPerspective: (
        src: CvMat,
        dst: CvMat,
        m: CvMat,
        dsize: { width: number; height: number },
        flags?: number,
        borderMode?: number
      ) => void;
      countNonZero: (src: CvMat) => number;
      COLOR_RGBA2GRAY: number;
      ADAPTIVE_THRESH_GAUSSIAN_C: number;
      THRESH_BINARY_INV: number;
      THRESH_OTSU: number;
      CV_32FC2: number;
      INTER_LINEAR: number;
      BORDER_CONSTANT: number;
    };
  }
}

export interface CvMat {
  cols: number;
  rows: number;
  ucharPtr: (row: number, col: number) => Uint8Array;
  roi: (rect: { x: number; y: number; width: number; height: number }) => CvMat;
  delete: () => void;
}

const OPENCV_READY_TIMEOUT_MS = 25000;

let loadingPromise: Promise<typeof window.cv> | null = null;

export const loadOpenCv = async (): Promise<typeof window.cv> => {
  if (typeof window === "undefined") {
    throw new Error("OpenCV can only be loaded in browser context.");
  }

  if (window.cv) {
    return window.cv;
  }

  if (!loadingPromise) {
    loadingPromise = new Promise<typeof window.cv>((resolve, reject) => {
      let settled = false;
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        resolve(window.cv as typeof window.cv);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        loadingPromise = null;
        reject(error);
      };

      const isRuntimeReady = () =>
        Boolean(window.cv && typeof window.cv.Mat === "function" && typeof window.cv.imread === "function");

      const startRuntimeWatch = () => {
        const startedAt = Date.now();
        const poll = window.setInterval(() => {
          if (isRuntimeReady()) {
            window.clearInterval(poll);
            finishResolve();
            return;
          }

          if (Date.now() - startedAt > OPENCV_READY_TIMEOUT_MS) {
            window.clearInterval(poll);
            finishReject(
              new Error(
                "OpenCV runtime initialization timed out. Please refresh and try again."
              )
            );
          }
        }, 100);
      };

      const script = document.createElement("script");
      script.src = "/opencv.js";
      script.async = true;
      script.onload = () => {
        if (isRuntimeReady()) {
          finishResolve();
          return;
        }

        const cvAny = (
          globalThis as { cv?: { onRuntimeInitialized?: () => void } }
        ).cv;
        if (cvAny) {
          const previous = cvAny.onRuntimeInitialized;
          cvAny.onRuntimeInitialized = () => {
            previous?.();
            if (isRuntimeReady()) {
              finishResolve();
            }
          };
          startRuntimeWatch();
        } else {
          startRuntimeWatch();
        }
      };
      script.onerror = () => {
        finishReject(new Error("Unable to load OpenCV.js"));
      };
      document.body.appendChild(script);
    });
  }

  try {
    return await loadingPromise;
  } catch (error) {
    loadingPromise = null;
    throw error;
  }
};
