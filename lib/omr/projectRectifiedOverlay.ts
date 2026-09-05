import type { CornerPointMap, NormalizedCornerPoint } from "./manualCornerCalibration";

interface ProjectiveTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
}

const buildUnitSquareTransform = (
  corners: CornerPointMap
): ProjectiveTransform => {
  const { tl, tr, br, bl } = corners;
  const dx1 = tr.x - br.x;
  const dx2 = bl.x - br.x;
  const dx3 = tl.x - tr.x + br.x - bl.x;
  const dy1 = tr.y - br.y;
  const dy2 = bl.y - br.y;
  const dy3 = tl.y - tr.y + br.y - bl.y;
  const denominator = dx1 * dy2 - dx2 * dy1;

  if (Math.abs(dx3) < 1e-10 && Math.abs(dy3) < 1e-10) {
    return {
      a: tr.x - tl.x,
      b: bl.x - tl.x,
      c: tl.x,
      d: tr.y - tl.y,
      e: bl.y - tl.y,
      f: tl.y,
      g: 0,
      h: 0
    };
  }
  if (Math.abs(denominator) < 1e-10) {
    throw new Error("The adjusted corners do not form a projectable sheet.");
  }

  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  return {
    a: tr.x - tl.x + g * tr.x,
    b: bl.x - tl.x + h * bl.x,
    c: tl.x,
    d: tr.y - tl.y + g * tr.y,
    e: bl.y - tl.y + h * bl.y,
    f: tl.y,
    g,
    h
  };
};

export const projectRectifiedPoint = (
  corners: CornerPointMap,
  point: NormalizedCornerPoint
): NormalizedCornerPoint => {
  const transform = buildUnitSquareTransform(corners);
  const scale = transform.g * point.x + transform.h * point.y + 1;
  if (Math.abs(scale) < 1e-10) {
    throw new Error("The adjusted corner projection is unstable.");
  }
  return {
    x: (transform.a * point.x + transform.b * point.y + transform.c) / scale,
    y: (transform.d * point.x + transform.e * point.y + transform.f) / scale
  };
};
