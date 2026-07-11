import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: ["public/opencv.js"]
  },
  ...nextVitals
];

export default config;
