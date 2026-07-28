# OMR Web App (OpenCV.js, Local-Only)

This project is a local-only web OMR scanner and photo exam grader for student
answer sheets.

## What it does

- Uses **OpenCV.js** in the browser to preprocess and evaluate filled bubbles.
- Uses **premade local template definitions** (no backend required).
- Stores processing state in the browser session only.
- Stores scan outputs as **JSON only** containing marks/shade information.
- Includes a default template matching the provided 100-item answer sheet layout.
- Provides separate routes for the established scanner (`/`) and the
  accuracy-first exam grader (`/grader`).

## JSON output contract

Scan output contains only bubble-related data:

- `student.studentId`: per-digit detected index + shade scores (0-9 rows); returns blank (`""`) when no dominant shade is detected
- `student.examCode`: per-digit detected index + shade scores; returns blank (`""`) when no dominant shade is detected
- `student.examSet`: selected set option(s) + shade scores/confidence
- `answers[]`: per question selected option(s), shade scores, confidence, ambiguous flag

Default darkness threshold is `0.28`, and it is user-configurable in the scanner UI.

No raw image blobs are persisted by default.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the app:

   ```bash
   npm run dev
   ```

3. Open:

   - `http://localhost:3000/` for the existing scanner.
   - `http://localhost:3000/grader` for photo grading.

## Photo exam grader

The grader supports Math Tests 1–4 with 100-question answer keys hardcoded in
`lib/exams/examCatalog.ts`. Select the exam first, then add one or more PNG,
JPEG, or WEBP photos. The exam stays locked until the batch is cleared.

The `grading-v2` worker mode:

- accepts images up to 2200 px on the longest side and measures resolution,
  sharpness, exposure, and local contrast;
- requires at least three real corner fiducials and infers no more than one;
- rectifies photos to the 1683 × 2167 reference-sheet geometry;
- normalizes broad shadows and lighting before applying low-strength CLAHE;
- fine-aligns the three answer columns independently;
- scores inner bubble ellipses against cached blank-sheet baselines; and
- reports single, blank, or ambiguous answers with per-choice normalized
  scores and confidence.

Unreliable photos are blocked with a specific retake instruction. Successful
photos show the detected student ID, score out of 100, quality diagnostics,
and a 100-question review. Manual A–D or explicit-blank overrides are kept
separate from the OpenCV result and can be reset to the detected value.

Photos, detections, and overrides remain in browser memory only. There is no
backend persistence or grader export.

## Reference images bundled in package

The app ships with bundled references under `public/reference`:

- `answer-sheet-reference.jpg`
- `corners/tl-snapshot.jpg`
- `corners/tr-snapshot.jpg`
- `corners/br-snapshot.jpg`
- `corners/bl-snapshot.jpg`

On page load, corner snapshots are preloaded from these bundled files and attached to the active template so scans immediately use quadrant `matchTemplate` corner detection.
The existing scanner keeps its original fallback behavior. The photo grader is
stricter: it requires three detected corner squares and may infer only one
missing corner before perspective correction.

## Review and correction flow

- Upload and run scan on the home page.
- Use **Open Visual Parse Steps** to inspect step-by-step parsing visuals (normalized image, grayscale, threshold map, corner detection, and ROI overlays).
- In the visual dialog, corner search windows are draggable; **Apply Corner Boxes** stores these exact regions for corner-square search and perspective normalization on the next scan.
- Apply manual corrections before save:
  - student ID digits
  - exam code digits
  - exam set
  - per-question selected choice(s)
- Review low-confidence/ambiguous items and adjust as needed.
- Save/override corrected JSON directly in the per-file dialog (frontend-only flow).

## Notes

- Current version performs threshold-based bubble scoring and returns JSON marks/shades.
- Corner-marker perspective correction is enabled using the four corner blocks from the template.
- Scanner photos keep the established preprocessing size. Grader photos use up
  to 2200 px on the longest side for more reliable pencil-mark detection.
- OpenCV runtime loading now has a timeout guard to avoid indefinite scan hangs.
- OMR scanning runs in a Web Worker so the UI stays responsive while processing.
- If worker initialization fails/times out, the scan stops with an explicit error (no blocking main-thread fallback).
- Active scans can be cancelled from the upload panel.
- Uploaded photos are pre-validated and normalized to standard JPEG before scan to reduce decode incompatibilities.
- OpenCV worker runtime is served locally (`/public/opencv-worker-runtime.js`) so loading is same-origin and more reliable.
- Worker failures include stage-tagged diagnostic errors to speed up root-cause debugging.
- Worker runtime is pre-warmed on page load to avoid first-scan initialization timeouts.
- Worker lifecycle and scan-stage logs are emitted to browser console (`[OMR Worker]`, `[OMR WorkerThread]`).
- For production, tune region coordinates and thresholds using real scans from your printer/camera setup.
