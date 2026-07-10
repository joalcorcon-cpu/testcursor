declare global {
  interface Window {
    cv: {
      Mat: new () => unknown;
      imread: (canvas: HTMLCanvasElement) => CvMat;
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
      COLOR_RGBA2GRAY: number;
      ADAPTIVE_THRESH_GAUSSIAN_C: number;
      THRESH_BINARY_INV: number;
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

let loadingPromise: Promise<typeof window.cv> | null = null;

export const loadOpenCv = async (): Promise<typeof window.cv> => {
  if (typeof window === "undefined") {
    throw new Error("OpenCV can only be loaded in browser context.");
  }

  if (window.cv) {
    return window.cv;
  }

  if (!loadingPromise) {
    loadingPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://docs.opencv.org/4.x/opencv.js";
      script.async = true;
      script.onload = () => {
        const timer = window.setInterval(() => {
          if (window.cv) {
            window.clearInterval(timer);
            resolve(window.cv);
          }
        }, 50);
      };
      script.onerror = () => {
        reject(new Error("Unable to load OpenCV.js"));
      };
      document.body.appendChild(script);
    });
  }

  return loadingPromise;
};
