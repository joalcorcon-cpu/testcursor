import assert from "node:assert/strict";
import test from "node:test";
import { applyRoiBoxesToTemplate, deriveRoiBoxesFromTemplate } from "@/lib/omr/roiCalibration";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";

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
