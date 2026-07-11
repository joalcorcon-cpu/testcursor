import assert from "node:assert/strict";
import test from "node:test";
import { applyRoiBoxesToTemplate, deriveRoiBoxesFromTemplate } from "@/lib/omr/roiCalibration";
import type { BubbleRegion } from "@/types/omr";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";

const boundsOf = (regions: BubbleRegion[]): BubbleRegion => {
  const left = Math.min(...regions.map((region) => region.x));
  const top = Math.min(...regions.map((region) => region.y));
  const right = Math.max(...regions.map((region) => region.x + region.w));
  const bottom = Math.max(...regions.map((region) => region.y + region.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
};

test("applyRoiBoxesToTemplate keeps fixed row/column structures", () => {
  const sourceBoxes = deriveRoiBoxesFromTemplate(defaultSheetTemplate);
  const adjustedBoxes = sourceBoxes.map((box) => ({
    ...box,
    x: box.x + 0.01,
    y: box.y + 0.005
  }));

  const calibrated = applyRoiBoxesToTemplate(defaultSheetTemplate, adjustedBoxes);

  assert.equal(calibrated.studentId.columns.length, 6);
  assert.equal(calibrated.studentId.columns[0]?.length, 10);
  assert.equal(calibrated.examCode.columns.length, 3);
  assert.equal(calibrated.examCode.columns[0]?.length, 10);
  assert.equal(calibrated.answers.length, 100);

  const answer1 = calibrated.answers[0];
  const answer2 = calibrated.answers[1];
  assert.ok(answer1.choices.A.x < answer1.choices.B.x);
  assert.ok(answer1.choices.B.x < answer1.choices.C.x);
  assert.ok(answer1.choices.C.x < answer1.choices.D.x);
  assert.ok(answer2.choices.A.y > answer1.choices.A.y);

  const studentRow1 = calibrated.studentId.columns[0];
  const studentRow2 = calibrated.studentId.columns[1];
  assert.ok(studentRow1[0].x < studentRow1[1].x);
  assert.ok(studentRow1[9].x > studentRow1[0].x);
  assert.ok(studentRow2[0].y > studentRow1[0].y);

  const examCodeRow1 = calibrated.examCode.columns[0];
  const examCodeRow2 = calibrated.examCode.columns[1];
  assert.ok(examCodeRow1[0].x < examCodeRow1[1].x);
  assert.ok(examCodeRow2[0].y > examCodeRow1[0].y);
});

test("calibrated bubble regions stay inside and touch ROI box bounds", () => {
  const sourceBoxes = deriveRoiBoxesFromTemplate(defaultSheetTemplate);
  const adjustedBoxes = sourceBoxes.map((box) => ({
    ...box,
    x: box.x + 0.008,
    y: box.y + 0.004,
    w: box.w - 0.006,
    h: box.h - 0.003
  }));

  const calibrated = applyRoiBoxesToTemplate(defaultSheetTemplate, adjustedBoxes);
  const derived = deriveRoiBoxesFromTemplate(calibrated);
  const byId = new Map(derived.map((box) => [box.id, box]));

  const studentIdBounds = boundsOf(calibrated.studentId.columns.flatMap((column) => column));
  const examCodeBounds = boundsOf(calibrated.examCode.columns.flatMap((column) => column));
  const examSetBounds = boundsOf(Object.values(calibrated.examSet.choices));
  const answersCol1Bounds = boundsOf(
    calibrated.answers.filter((answer) => answer.question <= 35).flatMap((answer) => Object.values(answer.choices))
  );

  const approxEqual = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;
  const expectBoundsMatch = (actual: BubbleRegion, expected: BubbleRegion) => {
    assert.ok(approxEqual(actual.x, expected.x));
    assert.ok(approxEqual(actual.y, expected.y));
    assert.ok(approxEqual(actual.w, expected.w));
    assert.ok(approxEqual(actual.h, expected.h));
  };

  expectBoundsMatch(studentIdBounds, byId.get("studentId")!);
  expectBoundsMatch(examCodeBounds, byId.get("examCode")!);
  expectBoundsMatch(examSetBounds, byId.get("examSet")!);
  expectBoundsMatch(answersCol1Bounds, byId.get("answersCol1")!);
});

test("deriveRoiBoxesFromTemplate returns persisted calibration boxes", () => {
  const sourceBoxes = deriveRoiBoxesFromTemplate(defaultSheetTemplate);
  const adjustedBoxes = sourceBoxes.map((box) => ({
    ...box,
    x: box.x + 0.0123,
    y: box.y + 0.0044,
    w: box.w - 0.0031,
    h: box.h - 0.0022
  }));

  const calibrated = applyRoiBoxesToTemplate(defaultSheetTemplate, adjustedBoxes);
  const derived = deriveRoiBoxesFromTemplate(calibrated);

  for (let i = 0; i < adjustedBoxes.length; i += 1) {
    assert.equal(derived[i].id, adjustedBoxes[i].id);
    assert.equal(derived[i].x, adjustedBoxes[i].x);
    assert.equal(derived[i].y, adjustedBoxes[i].y);
    assert.equal(derived[i].w, adjustedBoxes[i].w);
    assert.equal(derived[i].h, adjustedBoxes[i].h);
  }
});
