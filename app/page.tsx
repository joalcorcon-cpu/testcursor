"use client";

import { useState } from "react";
import { ScanUploader } from "@/components/ScanUploader";
import { ResultsReview } from "@/components/ResultsReview";
import { processSheetFileInWorker } from "@/lib/omr/processSheetInWorker";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import type { OMRResultJson, ScanRecord } from "@/types/omr";

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [uploader, setUploader] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanStage, setScanStage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OMRResultJson | null>(null);
  const [savedScans, setSavedScans] = useState<ScanRecord[]>([]);
  const [filters, setFilters] = useState({
    sourceName: "",
    templateId: "",
    from: "",
    to: ""
  });

  const refreshScans = async () => {
    const params = new URLSearchParams();
    if (filters.sourceName) params.set("sourceName", filters.sourceName);
    if (filters.templateId) params.set("templateId", filters.templateId);
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());

    const response = await fetch(`/api/scans?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "Unable to load scans.");
    }
    setSavedScans(payload.scans ?? []);
  };

  const runScan = async () => {
    if (!file) {
      setError("Choose an answer sheet image first.");
      return;
    }
    setLoading(true);
    setScanStage("Starting scan worker...");
    setError(null);
    try {
      const scanned = await processSheetFileInWorker(
        file,
        defaultSheetTemplate,
        (stage) => setScanStage(stage)
      );
      setResult(scanned);
      if (!sourceName) {
        setSourceName(file.name);
      }
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setScanStage(null);
      setLoading(false);
    }
  };

  const saveScan = async () => {
    if (!result) {
      setError("Run OMR scan first.");
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
          sourceName: sourceName || file?.name || "upload",
          uploader: uploader || undefined,
          resultJson: result
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Save failed.");
      }
      await refreshScans();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="main">
      <h1>OMR Answer Sheet Scanner</h1>
      <p className="subtitle">
        OpenCV.js runs in browser. Supabase stores template and scan JSON metadata only.
      </p>
      <div className="stack">
        <ScanUploader
          sourceName={sourceName}
          uploader={uploader}
          loading={loading}
          stage={scanStage}
          onSourceNameChange={setSourceName}
          onUploaderChange={setUploader}
          onFileChange={setFile}
          onRunScan={runScan}
        />
        <ResultsReview
          result={result}
          savedScans={savedScans}
          saving={saving}
          error={error}
          filters={filters}
          onFiltersChange={setFilters}
          onResultChange={setResult}
          onSave={saveScan}
          onRefreshScans={refreshScans}
        />
      </div>
    </main>
  );
}
