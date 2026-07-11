"use client";

interface ScanUploaderProps {
  sourceName: string;
  uploader: string;
  loading: boolean;
  hasFile: boolean;
  stage: string | null;
  calibrationMessage: string | null;
  onSourceNameChange: (value: string) => void;
  onUploaderChange: (value: string) => void;
  onFileChange: (file: File | null) => void;
  onRunScan: () => Promise<void>;
  onCancelScan: () => void;
  onOpenVisualDialog: () => Promise<void>;
}

export function ScanUploader({
  sourceName,
  uploader,
  loading,
  hasFile,
  stage,
  calibrationMessage,
  onSourceNameChange,
  onUploaderChange,
  onFileChange,
  onRunScan,
  onCancelScan,
  onOpenVisualDialog
}: ScanUploaderProps) {
  return (
    <section className="card">
      <h2>1) Upload answer sheet</h2>
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
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
      />
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
    </section>
  );
}
