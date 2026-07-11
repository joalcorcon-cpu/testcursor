# OMR Web App (OpenCV.js + Supabase)

This project is a web-based OMR scanner for student answer sheets.

## What it does

- Uses **OpenCV.js** in the browser to preprocess and evaluate filled bubbles.
- Uses **Supabase** as database for:
  - sheet template definitions (`templates`)
  - optional region rows (`template_regions`)
  - scan session metadata (`scan_sessions`)
  - scan result records (`scan_results`)
- Stores scan outputs as **JSON only** containing marks/shade information.
- Includes a default template matching the provided 100-item answer sheet layout.

## JSON output contract

Scan output contains only bubble-related data:

- `student.studentId`: per-digit detected index + shade scores (0-9 rows)
- `student.examCode`: per-digit detected index + shade scores
- `student.examSet`: selected set option(s) + shade scores/confidence
- `answers[]`: per question selected option(s), shade scores, confidence, ambiguous flag

No raw image blobs are stored in Supabase by default.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment variables in `.env.local`:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```

3. Create database tables in Supabase using:

   - [`supabase/schema.sql`](supabase/schema.sql)

4. (Optional) Seed the default template:

   - `POST /api/templates`

5. Start the app:

   ```bash
   npm run dev
   ```

## API routes

- `GET /api/templates` -> get templates (falls back to local default when env missing)
- `POST /api/templates` -> upsert default template to Supabase
- `GET /api/scans` -> list recent scan JSON records
- supports filters via query params: `sourceName`, `templateId`, `from`, `to`, `limit`
- `POST /api/scans` -> store one scan JSON record
  - creates a `scan_sessions` row, then writes `scan_results`

## Review and correction flow

- Upload and run scan on the home page.
- Apply manual corrections before save:
  - student ID digits
  - exam code digits
  - exam set
  - per-question selected choice(s)
- Review low-confidence/ambiguous items and adjust as needed.
- Save corrected JSON output to Supabase.

## Notes

- Current version performs threshold-based bubble scoring and returns JSON marks/shades.
- Corner-marker perspective correction is enabled using the four corner blocks from the template.
- Large photos are downscaled (max side ~800px) before processing to keep browser scans responsive.
- OpenCV runtime loading now has a timeout guard to avoid indefinite scan hangs.
- For production, tune region coordinates and thresholds using real scans from your printer/camera setup.
