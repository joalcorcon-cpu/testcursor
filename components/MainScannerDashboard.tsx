"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VisualParsingDialog } from "@/components/VisualParsingDialog";
import {
  buildRoiReadAreaStepsFromRectifiedDataUrl,
  buildVisualParsingSteps,
  type CornerWindowVisual,
  type VisualParseStep
} from "@/lib/omr/buildVisualParsingSteps";
import { applyRoiBoxesToTemplate, type RoiBoxVisual } from "@/lib/omr/roiCalibration";
import { processSheetFileInWorker, warmupOmrWorker } from "@/lib/omr/processSheetInWorker";
import { prepareImageForScan } from "@/lib/omr/prepareImageForScan";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import { loadBundledCornerSnapshots } from "@/lib/templates/loadBundledCornerSnapshots";
import type { CornerSnapshot, OMRResultJson, OMRTemplate } from "@/types/omr";

type QueueStatus = "queued" | "processing" | "done" | "error";

interface QueueFileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: QueueStatus;
  result: OMRResultJson | null;
  detail?: string;
  diagnostics?: string;
}

const makeFileId = (file: File, nonce: number) =>
  `${file.name}-${file.size}-${file.lastModified}-${nonce}`;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const excelHeaders = [
  "file_name",
  ...Array.from({ length: 6 }, (_, index) => `Student ID Number-${index}`),
  ...Array.from({ length: 3 }, (_, index) => `Exam Code-${index}`),
  "Exam Set-0",
  ...Array.from({ length: 35 }, (_, index) => `Answer Sheet 1-${index}`),
  ...Array.from({ length: 35 }, (_, index) => `Answer Sheet 2-${index}`),
  ...Array.from({ length: 30 }, (_, index) => `Answer Sheet 3-${index}`)
] as const;

export function MainScannerDashboard() {
  const [activeTemplate, setActiveTemplate] = useState<OMRTemplate>(() =>
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const [scanTemplateReady, setScanTemplateReady] = useState(false);
  const activeTemplateRef = useRef<OMRTemplate>(
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const referenceTemplateRef = useRef<OMRTemplate>(
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const queueRef = useRef<QueueFileItem[]>([]);

  const [queue, setQueue] = useState<QueueFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanStage, setScanStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [overrideFileId, setOverrideFileId] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState("");
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [visualDialogOpen, setVisualDialogOpen] = useState(false);
  const [visualDialogLoading, setVisualDialogLoading] = useState(false);
  const [visualDialogStage, setVisualDialogStage] = useState<string | null>(null);
  const [visualDialogError, setVisualDialogError] = useState<string | null>(null);
  const [visualSteps, setVisualSteps] = useState<VisualParseStep[]>([]);
  const [activeVisualFileId, setActiveVisualFileId] = useState<string | null>(null);
  const [autoProcessTick, setAutoProcessTick] = useState(0);
  const runBatchProcessRef = useRef<(() => Promise<void>) | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    activeTemplateRef.current = activeTemplate;
  }, [activeTemplate]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    void warmupOmrWorker().catch(() => {
      // Warmup is best-effort.
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(max-width: 960px)");
    const onChange = () => {
      const mobile = media.matches;
      setIsMobileViewport(mobile);
      if (!mobile) {
        setIsMobileDrawerOpen(false);
      }
    };
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadBundledCornerSnapshots().then((snapshots) => {
      if (disposed) {
        return;
      }
      if (!snapshots.tl || !snapshots.tr || !snapshots.br || !snapshots.bl) {
        return;
      }
      const nextReferenceTemplate: OMRTemplate = {
        ...referenceTemplateRef.current,
        cornerSnapshots: {
          ...(referenceTemplateRef.current.cornerSnapshots ?? {}),
          ...snapshots
        }
      };
      referenceTemplateRef.current = nextReferenceTemplate;
      // Visual dialog starts from bundled references, while scan uses
      // this reference template regardless of later draggable edits.
      setActiveTemplate(nextReferenceTemplate);
      setScanTemplateReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const updateQueueItem = (id: string, updater: (item: QueueFileItem) => QueueFileItem) => {
    setQueue((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  };

  const addFilesToQueue = (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    const existing = new Set(queueRef.current.map((item) => `${item.name}:${item.size}:${item.file.lastModified}`));
    const seed = Date.now();
    const newItems = files
      .filter((file) => /image\/(png|jpeg|webp)/.test(file.type))
      .filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`))
      .map((file, index) => ({
        id: makeFileId(file, seed + index),
        file,
        name: file.name,
        size: file.size,
        status: "queued" as const,
        result: null as OMRResultJson | null
      }));
    if (newItems.length > 0) {
      setQueue((current) => [...current, ...newItems]);
      setAutoProcessTick((value) => value + 1);
    }
  };

  const processOneFile = async (
    item: QueueFileItem,
    index: number,
    total: number,
    signal: AbortSignal
  ) => {
    updateQueueItem(item.id, (current) => ({
      ...current,
      status: "processing",
      detail: "Preparing image..."
    }));
    try {
      const prepared = await prepareImageForScan(item.file);
      const workerBuffer = prepared.rgbaBuffer.slice(0);
      const scanned = await processSheetFileInWorker(
        workerBuffer,
        prepared.width,
        prepared.height,
        referenceTemplateRef.current,
        (stage) => {
          setScanStage(`Processing ${index + 1}/${total}: ${item.name} — ${stage}`);
          updateQueueItem(item.id, (current) => ({ ...current, detail: stage }));
        },
        signal
      );
      updateQueueItem(item.id, (current) => ({
        ...current,
        status: "done",
        result: scanned,
        detail: "Scan complete",
        diagnostics: `Corners found ${scanned.pipeline.cornerFoundCount ?? 0}/4, used ${
          scanned.pipeline.cornerUsedCount ?? 0
        }/4, triangulated ${scanned.pipeline.cornerTriangulatedCount ?? 0}, warped ${
          scanned.pipeline.warped ? "yes" : "no"
        }`
      }));
    } catch (scanError) {
      updateQueueItem(item.id, (current) => ({
        ...current,
        status: "error",
        detail: scanError instanceof Error ? scanError.message : "Scan failed."
      }));
    }
  };

  const runBatchProcess = async () => {
    if (!scanTemplateReady) {
      setError("Corner reference snapshots are still loading. Please retry in a moment.");
      return;
    }
    const pending = queueRef.current.filter((item) => item.status === "queued" || item.status === "error");
    if (pending.length === 0) {
      setError("Add at least one file to start batch processing.");
      return;
    }
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    setAbortController(controller);
    try {
      for (let index = 0; index < pending.length; index += 1) {
        if (controller.signal.aborted) {
          break;
        }
        await processOneFile(pending[index], index, pending.length, controller.signal);
      }
    } finally {
      setLoading(false);
      setAbortController(null);
      setScanStage(null);
    }
  };
  runBatchProcessRef.current = runBatchProcess;

  useEffect(() => {
    if (!scanTemplateReady || loading) {
      return;
    }
    if (queueRef.current.some((item) => item.status === "queued")) {
      void runBatchProcessRef.current?.();
    }
  }, [autoProcessTick, loading, scanTemplateReady]);

  const cancelBatch = () => {
    abortController?.abort();
  };

  const deleteFromQueue = (id: string) => {
    const target = queueRef.current.find((item) => item.id === id);
    if (target?.status === "processing") {
      abortController?.abort();
    }
    setQueue((current) => current.filter((item) => item.id !== id));
    if (overrideFileId === id) {
      setOverrideFileId(null);
      setOverrideDraft("");
      setOverrideError(null);
    }
  };

  const openOverrideDialog = (id: string) => {
    const item = queueRef.current.find((entry) => entry.id === id);
    if (!item?.result) {
      setError("This file does not have a scan result yet.");
      return;
    }
    setOverrideFileId(id);
    setOverrideDraft(JSON.stringify(item.result, null, 2));
    setOverrideError(null);
  };

  const applyOverride = () => {
    if (!overrideFileId) {
      return;
    }
    try {
      const parsed = JSON.parse(overrideDraft) as OMRResultJson;
      updateQueueItem(overrideFileId, (item) => ({
        ...item,
        result: parsed,
        status: "done",
        detail: "Result overridden manually"
      }));
      setOverrideFileId(null);
      setOverrideDraft("");
      setOverrideError(null);
    } catch (parseError) {
      setOverrideError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
    }
  };

  const overrideItem = useMemo(
    () => queue.find((item) => item.id === overrideFileId) ?? null,
    [queue, overrideFileId]
  );
  const activeVisualFile = useMemo(
    () => queue.find((item) => item.id === activeVisualFileId) ?? null,
    [queue, activeVisualFileId]
  );

  const openVisualDialog = async (fileId: string) => {
    const target = queueRef.current.find((item) => item.id === fileId);
    if (!target) {
      setError("File not found for visual parsing.");
      return;
    }
    setActiveVisualFileId(fileId);
    setVisualDialogOpen(true);
    setVisualDialogLoading(true);
    setVisualDialogError(null);
    setVisualDialogStage("Preparing visual parsing steps...");
    try {
      const steps = await buildVisualParsingSteps(
        target.file,
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

  const rebuildVisualStepsForTemplate = async (
    template: OMRTemplate,
    stageMessage: string
  ): Promise<void> => {
    if (!activeVisualFile || !visualDialogOpen) {
      return;
    }
    setVisualDialogLoading(true);
    setVisualDialogError(null);
    setVisualDialogStage(stageMessage);
    try {
      const steps = await buildVisualParsingSteps(activeVisualFile.file, template, (stage) =>
        setVisualDialogStage(stage)
      );
      setVisualSteps(steps);
    } catch (dialogError) {
      setVisualDialogError(
        dialogError instanceof Error
          ? dialogError.message
          : "Unable to refresh visual parsing steps."
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
    const currentTemplate = activeTemplateRef.current;
    const nextCornerMarkers = currentTemplate.cornerMarkers.map((marker) => {
      const cornerWindow = windows.find((window) => window.id === marker.id);
      if (!cornerWindow) {
        return marker;
      }
      const nextWidth = Math.max(0.004, marker.w);
      const nextHeight = Math.max(0.004, marker.h);
      const centerX = cornerWindow.x + cornerWindow.w / 2;
      const centerY = cornerWindow.y + cornerWindow.h / 2;
      return {
        ...marker,
        x: Math.min(1 - nextWidth, Math.max(0, centerX - nextWidth / 2)),
        y: Math.min(1 - nextHeight, Math.max(0, centerY - nextHeight / 2)),
        w: nextWidth,
        h: nextHeight
      };
    });

    const nextTemplate: OMRTemplate = {
      ...currentTemplate,
      cornerSearchWindows: searchWindows,
      cornerMarkers: nextCornerMarkers
    };
    setActiveTemplate(nextTemplate);
    setVisualDialogError(null);
    setVisualSteps((current) =>
      current.map((step) => (step.id === "corners" ? { ...step, cornerWindows: windows } : step))
    );
    void rebuildVisualStepsForTemplate(nextTemplate, "Refreshing transformed sheet preview...");
  };

  const captureCornerSnapshots = (
    snapshots: Partial<Record<CornerWindowVisual["id"], CornerSnapshot>>
  ) => {
    const nextTemplate = {
      ...activeTemplateRef.current,
      cornerSnapshots: {
        ...(activeTemplateRef.current.cornerSnapshots ?? {}),
        ...snapshots
      }
    };
    setActiveTemplate(nextTemplate);
    setVisualDialogStage(
      "Corner snapshots captured. Next scan will use quadrant template matching for corners."
    );
  };

  const applyRoiBoxes = async (boxes: RoiBoxVisual[]) => {
    const nextTemplate = applyRoiBoxesToTemplate(activeTemplateRef.current, boxes);
    setActiveTemplate(nextTemplate);
    setVisualDialogError(null);
    const rectifiedStep = visualSteps.find((step) => step.id === "rectified");
    if (rectifiedStep?.imageDataUrl) {
      setVisualDialogLoading(true);
      setVisualDialogError(null);
      setVisualDialogStage("Updating ROI overlays without re-warping sheet...");
      try {
        const { regionsStep, readAreasStep } = await buildRoiReadAreaStepsFromRectifiedDataUrl(
          rectifiedStep.imageDataUrl,
          nextTemplate,
          (stage) => setVisualDialogStage(stage)
        );
        setVisualSteps((current) =>
          current.map((step) => {
            if (step.id === "regions") return regionsStep;
            if (step.id === "read-areas") return readAreasStep;
            return step;
          })
        );
      } catch {
        await rebuildVisualStepsForTemplate(nextTemplate, "Refreshing ROI preview...");
      } finally {
        setVisualDialogLoading(false);
        setVisualDialogStage(null);
      }
      return;
    }
    await rebuildVisualStepsForTemplate(nextTemplate, "Refreshing ROI preview...");
  };

  const handleSidebarToggle = () => {
    if (isMobileViewport) {
      setIsMobileDrawerOpen((value) => !value);
      return;
    }
    setIsSidebarCollapsed((value) => !value);
  };

  const closeMobileDrawer = () => {
    if (isMobileViewport) {
      setIsMobileDrawerOpen(false);
    }
  };

  const buildExcelRow = (item: QueueFileItem): string[] => {
    const row = new Array<string>(excelHeaders.length).fill("");
    row[0] = item.name;
    if (!item.result) {
      return row;
    }

    const studentDigits = item.result.student.studentId.detected ?? [];
    for (let index = 0; index < 6; index += 1) {
      const digit = studentDigits[index];
      row[1 + index] =
        typeof digit === "number" && digit >= 0 ? String(digit) : "";
    }

    const examCodeDigits = item.result.student.examCode.detected ?? [];
    for (let index = 0; index < 3; index += 1) {
      const digit = examCodeDigits[index];
      row[7 + index] =
        typeof digit === "number" && digit >= 0 ? String(digit) : "";
    }

    row[10] = item.result.student.examSet.selected?.[0] ?? "";

    for (let q = 1; q <= 100; q += 1) {
      const answer = item.result.answers.find((entry) => entry.q === q);
      const answerText = answer?.selected?.join(",") ?? "";
      if (q <= 35) {
        row[11 + (q - 1)] = answerText;
      } else if (q <= 70) {
        row[46 + (q - 36)] = answerText;
      } else {
        row[81 + (q - 71)] = answerText;
      }
    }

    return row;
  };

  const exportResultsToExcel = async () => {
    const doneRows = queueRef.current.filter((item) => item.result);
    if (doneRows.length === 0) {
      setError("No processed JSON results available to export.");
      return;
    }
    setExportBusy(true);
    setError(null);
    try {
      const XLSX = await import("xlsx");
      const rows = [Array.from(excelHeaders), ...doneRows.map((item) => buildExcelRow(item))];
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "results");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      XLSX.writeFile(workbook, `aerc-omr-results-${timestamp}.xlsx`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Unable to export Excel file.");
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <main className="main dashboard-main">
      <header className="appbar">
        <div className="appbar-left">
          <button className="appbar-menu" onClick={handleSidebarToggle} type="button" aria-label="Toggle sidebar">
            ☰
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="appbar-logo" src="/reference/aerc-logo.png" alt="AERC logo" />
          <strong>AERC OMR Scanner App</strong>
        </div>
        <div className="appbar-right">
          <button className="appbar-collapse" onClick={handleSidebarToggle} type="button">
            {isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          </button>
        </div>
      </header>
      <section
        className={`dashboard-shell${isSidebarCollapsed ? " sidebar-collapsed" : ""}${
          isMobileDrawerOpen ? " drawer-open" : ""
        }`}
      >
        <button
          className={`drawer-backdrop${isMobileDrawerOpen ? " drawer-backdrop-visible" : ""}`}
          onClick={closeMobileDrawer}
          aria-label="Close sidebar drawer"
          type="button"
        />
        <aside className="dashboard-sidebar">
          <div className="sidebar-brand">
            <strong>AERC</strong>
            <span>Since 1999</span>
          </div>
          <button className="sidebar-close" onClick={closeMobileDrawer} type="button">
            Close
          </button>
          <nav className="sidebar-nav">
            <button className="sidebar-link sidebar-link-active" onClick={closeMobileDrawer}>Scanner</button>
          </nav>
        </aside>

        <section className="dashboard-content">
          <header className="dashboard-header">
            <div>
              <h1 className="dashboard-title">AERC OMR Scanner App</h1>
              <p className="subtle-text">Upload files and they are processed automatically.</p>
            </div>
          </header>

          <section
            className={`upload-dropzone${dragActive ? " upload-dropzone-active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              addFilesToQueue(Array.from(event.dataTransfer.files));
            }}
          >
            <h3>Drag and drop OMR files here</h3>
            <p>Supports PNG, JPG, or WEBP.</p>
            <input
              id="omr-file-input"
              className="drop-area-input"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => addFilesToQueue(Array.from(event.target.files ?? []))}
            />
            <label htmlFor="omr-file-input" className="drop-action">Browse Files</label>
          </section>

          <section className="queue-section">
            <header>
              <h3>Processing Queue</h3>
              {scanStage ? <span className="subtle-text">{scanStage}</span> : null}
              {loading ? <button onClick={cancelBatch}>Cancel</button> : null}
              {!scanTemplateReady ? <span className="subtle-text">Loading template...</span> : null}
              <button onClick={() => void exportResultsToExcel()} disabled={exportBusy || queue.every((item) => !item.result)}>
                {exportBusy ? "Exporting..." : "Export Excel"}
              </button>
            </header>
            {error ? <p className="error">{error}</p> : null}
            {queue.length === 0 ? (
              <p className="subtle-text">No files added yet.</p>
            ) : (
              <div className="queue-list">
                {queue.map((item) => (
                  <article key={item.id} className="queue-card">
                    <div>
                      <strong>{item.name}</strong>
                      <p className="subtle-text">{formatBytes(item.size)}</p>
                      {item.detail ? <p className="subtle-text">{item.detail}</p> : null}
                      {item.diagnostics ? <p className="subtle-text">{item.diagnostics}</p> : null}
                    </div>
                    <div className="queue-actions">
                      <span className={`processing-badge processing-${item.status}`}>{item.status}</span>
                      <button onClick={() => void openVisualDialog(item.id)}>Visual Parse / Template</button>
                      <button onClick={() => openOverrideDialog(item.id)} disabled={!item.result}>
                        Override & JSON
                      </button>
                      <button onClick={() => deleteFromQueue(item.id)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>
      </section>

      {overrideItem ? (
        <div className="override-backdrop" role="presentation">
          <section className="override-dialog" role="dialog" aria-modal="true">
            <header className="modal-header">
              <h2>Override Result — {overrideItem.name}</h2>
              <button
                onClick={() => {
                  setOverrideFileId(null);
                  setOverrideDraft("");
                  setOverrideError(null);
                }}
              >
                Close
              </button>
            </header>
            <p className="subtle-text">Edit JSON override for this file.</p>
            <textarea
              className="override-json"
              value={overrideDraft}
              onChange={(event) => setOverrideDraft(event.target.value)}
            />
            {overrideError ? <p className="error">{overrideError}</p> : null}
            <div className="actions">
              <button onClick={applyOverride}>Apply Override</button>
            </div>
          </section>
        </div>
      ) : null}
      <VisualParsingDialog
        isOpen={visualDialogOpen}
        loading={visualDialogLoading}
        stage={visualDialogStage}
        error={visualDialogError}
        steps={visualSteps}
        onApplyCornerWindows={applyCornerWindows}
        onCaptureCornerSnapshots={captureCornerSnapshots}
        onApplyRoiBoxes={applyRoiBoxes}
        onClose={() => {
          setVisualDialogOpen(false);
          setActiveVisualFileId(null);
        }}
      />
    </main>
  );
}
