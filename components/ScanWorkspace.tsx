"use client";

import { useMemo, useState } from "react";
import { processSheetFile } from "@/lib/omr/processSheet";
import type { OMRResultJson, ScanRecord } from "@/types/omr";

export function ScanWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OMRResultJson | null>(null);
  const [savedScans, setSavedScans] = useState<ScanRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const prettyJson = useMemo(
    () => (result ? JSON.stringify(result, null, 2) : ""),
    [result]
  );

  const runScan = async () => {
    if (!file) {
      setError("Choose an answer sheet image first.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const scanned = await processSheetFile(file);
      setResult(scanned);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setLoading(false);
    }
  };

  const saveScan = async () => {
    if (!result) {
      setError("Run OMR scan before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: result.templateId,
          sourceName: file?.name ?? "upload",
          resultJson: result
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to save JSON scan result.");
      }
      await loadRecentScans();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const loadRecentScans = async () => {
    const response = await fetch("/api/scans", { cache: "no-store" });
    const payload = await response.json();
    if (response.ok && Array.isArray(payload.scans)) {
      setSavedScans(payload.scans);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>1) Upload answer sheet</h2>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <div className="actions">
          <button onClick={runScan} disabled={loading}>
            {loading ? "Scanning..." : "Run OMR Scan"}
          </button>
          <button onClick={saveScan} disabled={!result || saving}>
            {saving ? "Saving..." : "Save JSON Result"}
          </button>
          <button onClick={loadRecentScans}>Refresh Saved Scans</button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="card">
        <h2>2) JSON output (marks/shades only)</h2>
        <pre>{prettyJson || "No scan result yet."}</pre>
      </section>

      <section className="card">
        <h2>3) Recent stored JSON scans</h2>
        {savedScans.length === 0 ? (
          <p>No scans loaded.</p>
        ) : (
          <ul>
            {savedScans.map((scan) => (
              <li key={scan.id}>
                <strong>{scan.source_name}</strong> - {new Date(scan.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
