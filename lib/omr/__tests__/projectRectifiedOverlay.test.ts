import assert from "node:assert/strict";
import test from "node:test";
import type { CornerPointMap } from "../manualCornerCalibration";
import { projectRectifiedPoint } from "../projectRectifiedOverlay";

const assertPoint = (
  actual: { x: number; y: number },
  expected: { x: number; y: number }
) => {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
};

test("projects unit-square corners onto the adjusted outer rectangle", () => {
  const corners: CornerPointMap = {
    tl: { x: 0.1, y: 0.08 },
    tr: { x: 0.9, y: 0.12 },
    br: { x: 1.02, y: 0.94 },
    bl: { x: 0.04, y: 0.88 }
  };

  assertPoint(projectRectifiedPoint(corners, { x: 0, y: 0 }), corners.tl);
  assertPoint(projectRectifiedPoint(corners, { x: 1, y: 0 }), corners.tr);
  assertPoint(projectRectifiedPoint(corners, { x: 1, y: 1 }), corners.br);
  assertPoint(projectRectifiedPoint(corners, { x: 0, y: 1 }), corners.bl);
});

test("projects ROI points through an affine rectangle", () => {
  const corners: CornerPointMap = {
    tl: { x: 0.1, y: 0.2 },
    tr: { x: 0.9, y: 0.2 },
    br: { x: 0.9, y: 0.8 },
    bl: { x: 0.1, y: 0.8 }
  };

  assertPoint(
    projectRectifiedPoint(corners, { x: 0.25, y: 0.5 }),
    { x: 0.3, y: 0.5 }
  );
});
