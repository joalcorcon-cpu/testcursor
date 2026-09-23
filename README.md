# AERC OMR Scanner App

Browser-based OMR scanning for student answer sheets using OpenCV.js.

This app is **local-only** by design:

- no Supabase/backend dependency
- no server-side image processing
- no image persistence by default
- scan output is generated in-memory and exported as JSON/Excel

---

## Core features

- Multi-file upload queue with automatic processing
- OpenCV.js pipeline running in a Web Worker (responsive UI)
- Bundled template + corner snapshots loaded at startup
- Perspective correction using corner detection + triangulation fallback
- Review Scan dialog with interactive bubble overrides
- Visual Parse dialog for step-by-step debugging
- Queue-level warning/error chips and filtering
- Excel export with:
  - frozen header row
  - auto-fit columns
  - conditional formatting for empty required cells

---

## Tech stack

- Next.js + React + TypeScript
- OpenCV.js (client-side)
- Web Worker runtime in `public/omr-worker.js`
- Excel export via `exceljs`

---

## Local development

Install:

```bash
npm install
```

Run dev server:

```bash
npm run dev
```

Build production:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

Tests:

```bash
npm test
```

---

## App workflow

1. Upload one or more sheet images (`png`, `jpg/jpeg`, `webp`)
2. Files are queued and processed automatically
3. Corner detection + warp + bubble scoring run in worker
4. Results are shown per file with issues/warnings
5. User can:
   - review transformed overlay + detected answers
   - override answers/ID/exam set
   - open visual parse/template tools
   - export accumulated results to Excel

---

## Template and references

Bundled references are under `public/reference`:

- `answer-sheet-reference.jpg`
- `corners/tl-snapshot.jpg`
- `corners/tr-snapshot.jpg`
- `corners/br-snapshot.jpg`
- `corners/bl-snapshot.jpg`

At page load, these snapshots are attached to the active template.

Template defaults are defined in:

- `lib/templates/defaultSheetTemplate.ts`
- `lib/templates/bundledReferences.ts`

ROI boxes are represented as normalized coordinates (0..1):

- `studentId`
- `examCode`
- `examSet`
- `answersCol1`
- `answersCol2`
- `answersCol3`

---

## Calibration tools

### 1) Corner + side calibration (global)

Use **Adjust Corners & Sides** to:

- pick a reference file
- drag one selected inferred corner
- drag top/right/bottom/left boundaries
- preview the resulting quadrilateral + projected ROIs live
- reprocess triangulated files with updated calibration

### 2) ROI calibration (global)

Use **Adjust ROIs** to:

- pick a rectified reference file
- move/resize all ROI groups in a dedicated UI
- apply updated ROI geometry globally
- reprocess the queue with the new layout

### 3) Visual parse tools (per-file)

Use **Visual Parse / Template** on queue items to inspect and tune:

- corner search windows
- corner snapshots
- ROI draft placement and read-area overlays

---

## Result schema (JSON)

Each processed file yields an `OMRResultJson`:

- `student.studentId.detected`: array of `number | ""`
- `student.examCode.detected`: array of `number | ""`
- `student.examSet.selected`: choice array (`A-D`)
- `answers[]`: selected choices + shade scores + confidence + ambiguity
- `pipeline`: diagnostics (warp/corner stats, triangulation, angle/uneven flags)

Type definitions are in `types/omr.ts`.

Default darkness threshold is `0.28` (user-editable in UI).

---

## Important implementation notes

- Images are normalized before scan (`lib/omr/prepareImageForScan.ts`)
- Large uploads are downscaled to max side ~1600px for performance
- Worker is prewarmed and guarded with timeouts
- Progress stages and failures are surfaced in the queue
- Dialogs lock background page scroll and are dismissible via backdrop click

---

## Deployment behavior

- Branch pushes create Vercel preview deployments
- Production URL updates only when changes are merged into `main`

---

## Repository map (high-value files)

- `components/MainScannerDashboard.tsx` — primary scanner UI + queue logic
- `components/VisualParsingDialog.tsx` — parse-step and ROI/corner editors
- `components/ManualCornerCalibrationDialog.tsx` — corner/side calibration
- `components/GlobalRoiCalibrationDialog.tsx` — global ROI calibration flow
- `public/omr-worker.js` — worker pipeline (detection, warp, scoring)
- `lib/omr/processSheetInWorker.ts` — worker messaging client
- `lib/omr/roiCalibration.ts` — ROI derivation and application
- `types/omr.ts` — core template/result contracts
