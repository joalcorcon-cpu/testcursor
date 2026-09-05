"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  deriveManualCornerCalibration,
  type CornerId,
  type CornerPointMap,
  type NormalizedCornerPoint
} from "@/lib/omr/manualCornerCalibration";
import type { ManualCornerCalibration } from "@/types/omr";

export interface CornerCalibrationFileOption {
  id: string;
  name: string;
  triangulated: boolean;
}

export interface PreparedCornerReference {
  imageDataUrl: string;
  points: CornerPointMap;
}

interface ManualCornerCalibrationDialogProps {
  files: CornerCalibrationFileOption[];
  onPrepare: (fileId: string) => Promise<PreparedCornerReference>;
  onFinalize: (
    calibration: ManualCornerCalibration,
    referenceFileId: string
  ) => void;
  onClose: () => void;
}

const cornerOptions: Array<{ id: CornerId; label: string }> = [
  { id: "tl", label: "Upper left" },
  { id: "tr", label: "Upper right" },
  { id: "br", label: "Lower right" },
  { id: "bl", label: "Lower left" }
];

const clampPoint = (value: number) => Math.min(1.2, Math.max(-0.2, value));

export function ManualCornerCalibrationDialog({
  files,
  onPrepare,
  onFinalize,
  onClose
}: ManualCornerCalibrationDialogProps) {
  const [cornerId, setCornerId] = useState<CornerId>("br");
  const [fileId, setFileId] = useState(
    files.find((file) => file.triangulated)?.id ?? files[0]?.id ?? ""
  );
  const [reference, setReference] = useState<PreparedCornerReference | null>(null);
  const [manualPoint, setManualPoint] = useState<NormalizedCornerPoint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const prepareReference = async () => {
    if (!fileId) {
      setError("Choose a reference file.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const prepared = await onPrepare(fileId);
      setReference(prepared);
      setManualPoint(prepared.points[cornerId]);
    } catch (prepareError) {
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : "Unable to prepare the corner reference."
      );
    } finally {
      setLoading(false);
    }
  };

  const movePoint = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    setManualPoint({
      x: clampPoint((event.clientX - rect.left) / rect.width),
      y: clampPoint((event.clientY - rect.top) / rect.height)
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    movePoint(event);
  };

  const finalize = () => {
    if (!reference || !manualPoint || !fileId) {
      setError("Load a reference and position the selected corner first.");
      return;
    }
    try {
      onFinalize(
        deriveManualCornerCalibration(reference.points, cornerId, manualPoint),
        fileId
      );
    } catch (calibrationError) {
      setError(
        calibrationError instanceof Error
          ? calibrationError.message
          : "Unable to calculate the corner adjustment."
      );
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
        className="manual-corner-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-corner-title"
      >
        <header className="modal-header">
          <div>
            <h2 id="manual-corner-title">Adjust triangulated corner</h2>
            <p className="subtle-text">
              Calibrate one missing corner from a reference scan, then reuse that
              offset on triangulated files.
            </p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="manual-corner-controls">
          <label>
            Corner to adjust
            <select
              value={cornerId}
              disabled={loading}
              onChange={(event) => {
                const nextCornerId = event.target.value as CornerId;
                setCornerId(nextCornerId);
                setReference(null);
                setManualPoint(null);
              }}
            >
              {cornerOptions.map((corner) => (
                <option key={corner.id} value={corner.id}>{corner.label}</option>
              ))}
            </select>
          </label>
          <label>
            Reference file
            <select
              value={fileId}
              disabled={loading}
              onChange={(event) => {
                setFileId(event.target.value);
                setReference(null);
                setManualPoint(null);
              }}
            >
              {files.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.name}{file.triangulated ? " — triangulated" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void prepareReference()} disabled={loading || !fileId}>
            {loading ? "Detecting corners..." : reference ? "Reload reference" : "Load reference"}
          </button>
        </div>

        {reference && manualPoint ? (
          <>
            <p className="manual-corner-help">
              Drag the highlighted point to the intended corner. The padded area
              permits placement up to 20% outside the image.
            </p>
            <div className="manual-corner-canvas">
              <div className="manual-corner-image-stage" ref={stageRef}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={reference.imageDataUrl} alt="Unwarped reference answer sheet" />
                {(Object.entries(reference.points) as Array<
                  [CornerId, NormalizedCornerPoint]
                >).map(([id, point]) => (
                  <span
                    key={id}
                    className={`manual-corner-point manual-corner-point-fixed${
                      id === cornerId ? " manual-corner-point-original" : ""
                    }`}
                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                    title={`${id.toUpperCase()} detected or triangulated point`}
                  />
                ))}
                <button
                  type="button"
                  className="manual-corner-point manual-corner-point-active"
                  style={{ left: `${manualPoint.x * 100}%`, top: `${manualPoint.y * 100}%` }}
                  aria-label={`Move ${cornerId.toUpperCase()} corner`}
                  title="Drag adjusted corner"
                  onPointerDown={handlePointerDown}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      movePoint(event);
                    }
                  }}
                />
              </div>
            </div>
            <p className="subtle-text">
              Position: {(manualPoint.x * 100).toFixed(2)}% ×{" "}
              {(manualPoint.y * 100).toFixed(2)}%
            </p>
          </>
        ) : (
          <div className="manual-corner-empty">
            Choose the corner and reference file, then load the reference.
          </div>
        )}

        {error ? <p className="error">{error}</p> : null}
        <footer className="actions manual-corner-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary-action"
            disabled={!reference || !manualPoint || loading}
            onClick={finalize}
          >
            Finalize and reprocess triangulated files
          </button>
        </footer>
      </section>
    </div>
  );
}
