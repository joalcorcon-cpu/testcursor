"use client";

import { useState } from "react";
import { RoiBoxEditor } from "@/components/VisualParsingDialog";
import type { RoiBoxVisual } from "@/lib/omr/roiCalibration";

export interface RoiCalibrationFileOption {
  id: string;
  name: string;
}

export interface PreparedRoiReference {
  imageDataUrl: string;
  roiBoxes: RoiBoxVisual[];
}

interface GlobalRoiCalibrationDialogProps {
  files: RoiCalibrationFileOption[];
  onPrepare: (fileId: string) => Promise<PreparedRoiReference>;
  onFinalize: (boxes: RoiBoxVisual[], referenceFileId: string) => void;
  onClose: () => void;
}

const ignoreDraftChanges = () => {};

export function GlobalRoiCalibrationDialog({
  files,
  onPrepare,
  onFinalize,
  onClose
}: GlobalRoiCalibrationDialogProps) {
  const [fileId, setFileId] = useState(files[0]?.id ?? "");
  const [reference, setReference] = useState<PreparedRoiReference | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepareReference = async () => {
    if (!fileId) {
      setError("Choose a reference file.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setReference(await onPrepare(fileId));
    } catch (prepareError) {
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : "Unable to prepare the ROI reference."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="override-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="global-roi-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-roi-title"
      >
        <header className="modal-header">
          <div>
            <h2 id="global-roi-title">Adjust regions of interest</h2>
            <p className="subtle-text">
              Choose one file as the rectified reference, then move or resize the
              extraction regions.
            </p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="global-roi-controls">
          <label>
            Reference file
            <select
              value={fileId}
              disabled={loading}
              onChange={(event) => {
                setFileId(event.target.value);
                setReference(null);
              }}
            >
              {files.map((file) => (
                <option key={file.id} value={file.id}>{file.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={loading || !fileId}
            onClick={() => void prepareReference()}
          >
            {loading
              ? "Rectifying reference..."
              : reference
                ? "Reload reference"
                : "Load reference"}
          </button>
        </div>

        {error ? <p className="error">{error}</p> : null}
        {reference ? (
          <RoiBoxEditor
            key={`${fileId}-${reference.imageDataUrl.slice(-24)}`}
            baseImageDataUrl={reference.imageDataUrl}
            initialRoiBoxes={reference.roiBoxes}
            onDraftRoiBoxesChange={ignoreDraftChanges}
            onApplyRoiBoxes={(boxes) => onFinalize(boxes, fileId)}
          />
        ) : (
          <div className="manual-corner-empty">
            Select a reference file and load its transformed image.
          </div>
        )}
      </section>
    </div>
  );
}
