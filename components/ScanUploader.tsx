"use client";

import { useState, type DragEvent } from "react";

type ProcessingStatus = "queued" | "processing" | "done" | "error";

interface ProcessingFileItem {
  id: string;
  name: string;
  status: ProcessingStatus;
  detail?: string;
}

interface ScanUploaderProps {
  sourceName: string;
  uploader: string;
  loading: boolean;
  hasFile: boolean;
  processingFiles: ProcessingFileItem[];
  stage: string | null;
  calibrationMessage: string | null;
  onSourceNameChange: (value: string) => void;
  onUploaderChange: (value: string) => void;
  onFileChange: (files: File[]) => void;
  onRunScan: () => Promise<void>;
  onCancelScan: () => void;
  onOpenVisualDialog: () => Promise<void>;
}

export function ScanUploader({
  sourceName,
  uploader,
  loading,
  hasFile,
  processingFiles,
  stage,
  calibrationMessage,
  onSourceNameChange,
  onUploaderChange,
  onFileChange,
  onRunScan,
  onCancelScan,
  onOpenVisualDialog
}: ScanUploaderProps) {
  const [dragActive, setDragActive] = useState(false);
  const statusLabel: Record<ProcessingStatus, string> = {
    queued: "Queued",
    processing: "Processing",
    done: "Done",
    error: "Error"
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const droppedFiles = Array.from(event.dataTransfer.files).filter((file) =>
      /image\/(png|jpeg|webp)/.test(file.type)
    );
    if (droppedFiles.length > 0) {
      onFileChange(droppedFiles);
    }
  };

  return (
    <section className="card">
      <h2>1) Upload answer sheets</h2>
      <div className="field-grid">
        <label>
          Source name
          <input
            type="text"
            value={sourceName}
            onChange={(event) => onSourceNameChange(event.target.value)}
            placeholder="student-sheet-01.jpg"
          />
        </label>
        <label>
          Uploader (optional)
          <input
            type="text"
            value={uploader}
            onChange={(event) => onUploaderChange(event.target.value)}
            placeholder="Teacher name"
          />
        </label>
      </div>
      <div
        className={`drop-area${dragActive ? " drop-area-active" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <strong>Drop image files here</strong>
        <p className="subtle-text">PNG, JPG, or WEBP. You can upload multiple files.</p>
        <input
          id="file-input"
          className="drop-area-input"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => onFileChange(Array.from(event.target.files ?? []))}
        />
        <label htmlFor="file-input" className="drop-area-browse">
          Browse files
        </label>
      </div>
      <div className="actions">
        <button onClick={() => void onRunScan()} disabled={loading}>
          {loading ? "Scanning..." : "Run OMR Scan"}
        </button>
        <button onClick={() => void onOpenVisualDialog()} disabled={loading || !hasFile}>
          Open Visual Parse Steps
        </button>
        {loading ? <button onClick={onCancelScan}>Cancel Scan</button> : null}
      </div>
      {!loading && calibrationMessage ? <p className="subtle-text">{calibrationMessage}</p> : null}
      {loading && stage ? <p className="subtle-text">{stage}</p> : null}
      <section className="processing-list">
        <h3>Files being processed</h3>
        {processingFiles.length === 0 ? (
          <p className="subtle-text">No files selected yet.</p>
        ) : (
          <ul>
            {processingFiles.map((entry) => (
              <li key={entry.id}>
                <span>{entry.name}</span>
                <span className={`processing-badge processing-${entry.status}`}>
                  {statusLabel[entry.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
