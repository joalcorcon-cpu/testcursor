import type { CornerMarker, ManualCornerCalibration } from "@/types/omr";

export type CornerId = CornerMarker["id"];

export interface NormalizedCornerPoint {
  x: number;
  y: number;
}

export type CornerPointMap = Record<CornerId, NormalizedCornerPoint>;

const subtract = (a: NormalizedCornerPoint, b: NormalizedCornerPoint) => ({
  x: a.x - b.x,
  y: a.y - b.y
});

export const inferCornerFromThree = (
  points: CornerPointMap,
  cornerId: CornerId
): NormalizedCornerPoint => {
  switch (cornerId) {
    case "tl":
      return {
        x: points.tr.x + points.bl.x - points.br.x,
        y: points.tr.y + points.bl.y - points.br.y
      };
    case "tr":
      return {
        x: points.tl.x + points.br.x - points.bl.x,
        y: points.tl.y + points.br.y - points.bl.y
      };
    case "br":
      return {
        x: points.tr.x + points.bl.x - points.tl.x,
        y: points.tr.y + points.bl.y - points.tl.y
      };
    case "bl":
      return {
        x: points.tl.x + points.br.x - points.tr.x,
        y: points.tl.y + points.br.y - points.tr.y
      };
  }
};

const calibrationAxes = (points: CornerPointMap, cornerId: CornerId) => {
  switch (cornerId) {
    case "tl":
      return {
        horizontal: subtract(points.br, points.bl),
        vertical: subtract(points.br, points.tr)
      };
    case "tr":
      return {
        horizontal: subtract(points.br, points.bl),
        vertical: subtract(points.bl, points.tl)
      };
    case "br":
      return {
        horizontal: subtract(points.tr, points.tl),
        vertical: subtract(points.bl, points.tl)
      };
    case "bl":
      return {
        horizontal: subtract(points.tr, points.tl),
        vertical: subtract(points.br, points.tr)
      };
  }
};

export const deriveManualCornerCalibration = (
  points: CornerPointMap,
  cornerId: CornerId,
  manualPoint: NormalizedCornerPoint
): ManualCornerCalibration => {
  const inferredPoint = inferCornerFromThree(points, cornerId);
  const delta = subtract(manualPoint, inferredPoint);
  const { horizontal, vertical } = calibrationAxes(points, cornerId);
  const determinant = horizontal.x * vertical.y - horizontal.y * vertical.x;

  if (Math.abs(determinant) < 1e-8) {
    throw new Error("The three reference corners do not define a usable sheet.");
  }

  return {
    cornerId,
    offsetU: (delta.x * vertical.y - delta.y * vertical.x) / determinant,
    offsetV: (horizontal.x * delta.y - horizontal.y * delta.x) / determinant
  };
};

export const applyManualCornerCalibration = (
  points: CornerPointMap,
  calibration: ManualCornerCalibration
): NormalizedCornerPoint => {
  const inferredPoint = inferCornerFromThree(points, calibration.cornerId);
  const { horizontal, vertical } = calibrationAxes(points, calibration.cornerId);
  return {
    x:
      inferredPoint.x +
      calibration.offsetU * horizontal.x +
      calibration.offsetV * vertical.x,
    y:
      inferredPoint.y +
      calibration.offsetU * horizontal.y +
      calibration.offsetV * vertical.y
  };
};
