# OMR Web App (OpenCV.js, Local-Only)

This project is a web-based OMR scanner for student answer sheets.

## What it does

- Uses **OpenCV.js** in the browser to preprocess and evaluate filled bubbles.
- Uses **premade local template definitions** (no backend required).
- Stores processing state in the browser session only.
- Stores scan outputs as **JSON only** containing marks/shade information.
- Includes a default template matching the provided 100-item answer sheet layout.

## JSON output contract

Scan output contains only bubble-related data:

- `student.studentId`: per-digit detected index + shade scores (0-9 rows)
- `student.examCode`: per-digit detected index + shade scores
- `student.examSet`: selected set option(s) + shade scores/confidence
- `answers[]`: per question selected option(s), shade scores, confidence, ambiguous flag

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

## Reference images bundled in package

The app ships with bundled references under `public/reference`:

- `answer-sheet-reference.jpg`
- `corners/tl-snapshot.jpg`
- `corners/tr-snapshot.jpg`
- `corners/br-snapshot.jpg`
- `corners/bl-snapshot.jpg`

On page load, corner snapshots are preloaded from these bundled files and attached to the active template so scans immediately use quadrant `matchTemplate` corner detection.
If one or two corners are not found, a rectangle-based triangulation fallback estimates missing corners before perspective transform.

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
- Large photos are downscaled (max side ~800px) before processing to keep browser scans responsive.
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
