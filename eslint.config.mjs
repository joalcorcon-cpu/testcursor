import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: ["public/opencv.js", "public/opencv-worker-runtime.js"]
  },
  ...nextVitals
];

export default config;
