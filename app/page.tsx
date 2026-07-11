"use client";

import { useEffect, useRef, useState } from "react";
import { ScanUploader } from "@/components/ScanUploader";
import { ResultsReview } from "@/components/ResultsReview";
import { VisualParsingDialog } from "@/components/VisualParsingDialog";
import {
  type CornerWindowVisual,
  buildVisualParsingSteps,
  type VisualParseStep
} from "@/lib/omr/buildVisualParsingSteps";
import { processSheetFileInWorker, warmupOmrWorker } from "@/lib/omr/processSheetInWorker";
import { prepareImageForScan } from "@/lib/omr/prepareImageForScan";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import type { OMRResultJson, OMRTemplate, ScanRecord } from "@/types/omr";

export default function HomePage() {
  const [activeTemplate, setActiveTemplate] = useState<OMRTemplate>(() =>
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const activeTemplateRef = useRef<OMRTemplate>(
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const [file, setFile] = useState<File | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [uploader, setUploader] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanStage, setScanStage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OMRResultJson | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [visualDialogOpen, setVisualDialogOpen] = useState(false);
  const [visualDialogLoading, setVisualDialogLoading] = useState(false);
  const [visualDialogStage, setVisualDialogStage] = useState<string | null>(null);
  const [visualDialogError, setVisualDialogError] = useState<string | null>(null);
  const [visualSteps, setVisualSteps] = useState<VisualParseStep[]>([]);
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null);
  const [savedScans, setSavedScans] = useState<ScanRecord[]>([]);
  const [filters, setFilters] = useState({
    sourceName: "",
    templateId: "",
    from: "",
    to: ""
  });

  useEffect(() => {
    void warmupOmrWorker().catch(() => {
      // Warmup is best-effort; detailed errors surface during an explicit scan request.
    });
  }, []);

  useEffect(() => {
    activeTemplateRef.current = activeTemplate;
  }, [activeTemplate]);

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
    const controller = new AbortController();
    setAbortController(controller);
    try {
      setScanStage("Validating and normalizing image...");
      const prepared = await prepareImageForScan(file);
      const workerBuffer = prepared.rgbaBuffer.slice(0);
      const scanned = await processSheetFileInWorker(
        workerBuffer,
        prepared.width,
        prepared.height,
        activeTemplateRef.current,
        (stage) => setScanStage(stage),
        controller.signal
      );
      setResult(scanned);
      if (!sourceName) {
        setSourceName(file.name);
      }
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setAbortController(null);
      setScanStage(null);
      setLoading(false);
    }
  };

  const cancelScan = () => {
    abortController?.abort();
  };

  const handleFileChange = (nextFile: File | null) => {
    setFile(nextFile);
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

  const openVisualDialog = async () => {
    if (!file) {
      setError("Choose an answer sheet image first.");
      return;
    }
    setVisualDialogOpen(true);
    setVisualDialogLoading(true);
    setVisualDialogError(null);
    setVisualDialogStage("Preparing visual parsing steps...");
    try {
      const steps = await buildVisualParsingSteps(
        file,
        activeTemplateRef.current,
        (stage) => setVisualDialogStage(stage)
      );
      setVisualSteps(steps);
    } catch (dialogError) {
      setVisualDialogError(
        dialogError instanceof Error
          ? dialogError.message
          : "Unable to generate visual parsing steps."
      );
    } finally {
      setVisualDialogLoading(false);
      setVisualDialogStage(null);
    }
  };

  const applyCornerWindows = (windows: CornerWindowVisual[]) => {
    const searchWindows = windows.reduce<NonNullable<OMRTemplate["cornerSearchWindows"]>>(
      (accumulator, cornerWindow) => {
        accumulator[cornerWindow.id] = {
          x: cornerWindow.x,
          y: cornerWindow.y,
          w: cornerWindow.w,
          h: cornerWindow.h
        };
        return accumulator;
      },
      {}
    );

    setActiveTemplate((current) => {
      const nextCornerMarkers = current.cornerMarkers.map((marker) => {
        const cornerWindow = windows.find((window) => window.id === marker.id);
        if (!cornerWindow) {
          return marker;
        }

        const nextWidth = Math.max(0.004, marker.w);
        const nextHeight = Math.max(0.004, marker.h);
        const centerX = cornerWindow.x + cornerWindow.w / 2;
        const centerY = cornerWindow.y + cornerWindow.h / 2;

        const nextX = Math.min(1 - nextWidth, Math.max(0, centerX - nextWidth / 2));
        const nextY = Math.min(1 - nextHeight, Math.max(0, centerY - nextHeight / 2));

        return {
          ...marker,
          x: nextX,
          y: nextY,
          w: nextWidth,
          h: nextHeight
        };
      });

      return {
        ...current,
        cornerSearchWindows: searchWindows,
        cornerMarkers: nextCornerMarkers
      };
    });
    setVisualDialogError(null);
    setVisualSteps((current) =>
      current.map((step) => (step.id === "corners" ? { ...step, cornerWindows: windows } : step))
    );
    setCalibrationMessage("Corner search windows applied. Next scan will use these regions.");
    setVisualDialogStage("Corner windows applied. Next scan will use these search regions.");
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
          hasFile={Boolean(file)}
          stage={scanStage}
          calibrationMessage={calibrationMessage}
          onSourceNameChange={setSourceName}
          onUploaderChange={setUploader}
          onFileChange={handleFileChange}
          onRunScan={runScan}
          onCancelScan={cancelScan}
          onOpenVisualDialog={openVisualDialog}
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
      <VisualParsingDialog
        isOpen={visualDialogOpen}
        loading={visualDialogLoading}
        stage={visualDialogStage}
        error={visualDialogError}
        steps={visualSteps}
        onApplyCornerWindows={applyCornerWindows}
        onClose={() => setVisualDialogOpen(false)}
      />
    </main>
  );
}
