import assert from "node:assert/strict";
import test from "node:test";
import {
  applyManualCornerCalibration,
  deriveManualCornerCalibration,
  inferCornerFromThree,
  type CornerPointMap
} from "../manualCornerCalibration";

const points: CornerPointMap = {
  tl: { x: 0.1, y: 0.1 },
  tr: { x: 0.9, y: 0.12 },
  br: { x: 0.88, y: 0.9 },
  bl: { x: 0.12, y: 0.88 }
};

test("infers the baseline lower-right corner from the other three", () => {
  const inferred = inferCornerFromThree(points, "br");
  assert.ok(Math.abs(inferred.x - 0.92) < 1e-9);
  assert.ok(Math.abs(inferred.y - 0.9) < 1e-9);
});

test("stores a manual corner as sheet-relative offsets", () => {
  const manualPoint = { x: 0.95, y: 0.94 };
  const calibration = deriveManualCornerCalibration(points, "br", manualPoint);
  const reapplied = applyManualCornerCalibration(points, calibration);

  assert.ok(Math.abs(reapplied.x - manualPoint.x) < 1e-9);
  assert.ok(Math.abs(reapplied.y - manualPoint.y) < 1e-9);
});

test("sheet-relative calibration scales to another scan", () => {
  const calibration = deriveManualCornerCalibration(
    points,
    "br",
    { x: 0.96, y: 0.95 }
  );
  const largerScan: CornerPointMap = {
    tl: { x: 0, y: 0 },
    tr: { x: 2, y: 0 },
    br: { x: 2, y: 2 },
    bl: { x: 0, y: 2 }
  };
  const reapplied = applyManualCornerCalibration(largerScan, calibration);

  assert.ok(reapplied.x > 2);
  assert.ok(reapplied.y > 2);
});
