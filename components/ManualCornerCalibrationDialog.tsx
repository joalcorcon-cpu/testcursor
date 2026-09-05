"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  type CornerId,
  type CornerPointMap,
  type NormalizedCornerPoint
} from "@/lib/omr/manualCornerCalibration";
import {
  projectRectifiedPoint,
  unprojectSourcePoint
} from "@/lib/omr/projectRectifiedOverlay";
import type { RoiBoxVisual } from "@/lib/omr/roiCalibration";
import type { ManualSideCalibration } from "@/types/omr";

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
  roiBoxes: RoiBoxVisual[];
  onPrepare: (fileId: string) => Promise<PreparedCornerReference>;
  onFinalize: (
    calibration: ManualSideCalibration,
    referenceFileId: string
  ) => void;
  onClose: () => void;
}

type SideId = keyof ManualSideCalibration;

const defaultSides: ManualSideCalibration = {
  top: 0,
  right: 1,
  bottom: 1,
  left: 0
};

const clampSide = (value: number) => Math.min(1.2, Math.max(-0.2, value));

const roiLabels: Record<RoiBoxVisual["id"], string> = {
  studentId: "Student ID",
  examCode: "Exam Code",
  examSet: "Exam Set",
  answersCol1: "Answers 1–35",
  answersCol2: "Answers 36–70",
  answersCol3: "Answers 71–100"
};

const polygonPoints = (points: NormalizedCornerPoint[]) =>
  points.map((point) => `${point.x * 100},${point.y * 100}`).join(" ");

export function ManualCornerCalibrationDialog({
  files,
  roiBoxes,
  onPrepare,
  onFinalize,
  onClose
}: ManualCornerCalibrationDialogProps) {
  const [fileId, setFileId] = useState(
    files.find((file) => file.triangulated)?.id ?? files[0]?.id ?? ""
  );
  const [reference, setReference] = useState<PreparedCornerReference | null>(null);
  const [sides, setSides] = useState<ManualSideCalibration>(defaultSides);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const adjustedCorners = reference
    ? {
        tl: projectRectifiedPoint(reference.points, {
          x: sides.left,
          y: sides.top
        }),
        tr: projectRectifiedPoint(reference.points, {
          x: sides.right,
          y: sides.top
        }),
        br: projectRectifiedPoint(reference.points, {
          x: sides.right,
          y: sides.bottom
        }),
        bl: projectRectifiedPoint(reference.points, {
          x: sides.left,
          y: sides.bottom
        })
      }
    : null;
  const projectedRois = adjustedCorners
    ? roiBoxes.flatMap((box) => {
        try {
          const points = [
            projectRectifiedPoint(adjustedCorners, { x: box.x, y: box.y }),
            projectRectifiedPoint(adjustedCorners, {
              x: box.x + box.w,
              y: box.y
            }),
            projectRectifiedPoint(adjustedCorners, {
              x: box.x + box.w,
              y: box.y + box.h
            }),
            projectRectifiedPoint(adjustedCorners, {
              x: box.x,
              y: box.y + box.h
            })
          ];
          const labelPoint = projectRectifiedPoint(adjustedCorners, {
            x: box.x + box.w / 2,
            y: box.y + box.h / 2
          });
          return [{ box, points, labelPoint }];
        } catch {
          return [];
        }
      })
    : [];
  const sideLines: Array<{
    id: SideId;
    start: NormalizedCornerPoint;
    end: NormalizedCornerPoint;
  }> = adjustedCorners
    ? [
        { id: "top", start: adjustedCorners.tl, end: adjustedCorners.tr },
        { id: "right", start: adjustedCorners.tr, end: adjustedCorners.br },
        { id: "bottom", start: adjustedCorners.bl, end: adjustedCorners.br },
        { id: "left", start: adjustedCorners.tl, end: adjustedCorners.bl }
      ]
    : [];

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
      setSides(defaultSides);
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

  const moveSide = (
    event: ReactPointerEvent<SVGLineElement>,
    side: SideId
  ) => {
    const stage = stageRef.current;
    if (!stage || !reference) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    try {
      const sheetPoint = unprojectSourcePoint(reference.points, {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height
      });
      setSides((current) => {
        const nextValue = clampSide(
          side === "left" || side === "right" ? sheetPoint.x : sheetPoint.y
        );
        const next = { ...current, [side]: nextValue };
        if (next.left + 0.1 >= next.right || next.top + 0.1 >= next.bottom) {
          return current;
        }
        return next;
      });
    } catch {
      // Ignore unstable pointer positions while a side is being dragged.
    }
  };

  const handlePointerDown = (
    event: ReactPointerEvent<SVGLineElement>,
    side: SideId
  ) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    moveSide(event, side);
  };

  const finalize = () => {
    if (!reference || !fileId) {
      setError("Load a reference and position the sheet sides first.");
      return;
    }
    onFinalize(sides, fileId);
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
            <h2 id="manual-corner-title">Adjust sheet sides</h2>
            <p className="subtle-text">
              Move the sheet boundaries on one reference scan. Their intersections
              become the four warp corners for triangulated files.
            </p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="manual-corner-controls">
          <label>
            Reference file
            <select
              value={fileId}
              disabled={loading}
              onChange={(event) => {
                setFileId(event.target.value);
                setReference(null);
                setSides(defaultSides);
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

        {reference && adjustedCorners ? (
          <>
            <p className="manual-corner-help">
              Drag any blue side to the intended sheet boundary. The padded area
              permits boundaries outside the image; intersections and ROIs update
              dynamically.
            </p>
            <div className="manual-corner-canvas">
              <div className="manual-corner-image-stage" ref={stageRef}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={reference.imageDataUrl} alt="Unwarped reference answer sheet" />
                {adjustedCorners ? (
                  <svg
                    className="manual-corner-projection"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polygon
                      className="manual-corner-outer-polygon"
                      points={polygonPoints([
                        adjustedCorners.tl,
                        adjustedCorners.tr,
                        adjustedCorners.br,
                        adjustedCorners.bl
                      ])}
                      vectorEffect="non-scaling-stroke"
                    />
                    {projectedRois.map(({ box, points, labelPoint }) => (
                      <g key={box.id}>
                        <polygon
                          className={`manual-corner-roi manual-corner-roi-${box.id}`}
                          points={polygonPoints(points)}
                          vectorEffect="non-scaling-stroke"
                        />
                        <text
                          className="manual-corner-roi-label"
                          x={labelPoint.x * 100}
                          y={labelPoint.y * 100}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          vectorEffect="non-scaling-stroke"
                        >
                          {roiLabels[box.id]}
                        </text>
                      </g>
                    ))}
                    {sideLines.map(({ id, start, end }) => (
                      <line
                        key={`side-hitbox-${id}`}
                        className={`manual-side-hitbox manual-side-hitbox-${id}`}
                        x1={start.x * 100}
                        y1={start.y * 100}
                        x2={end.x * 100}
                        y2={end.y * 100}
                        vectorEffect="non-scaling-stroke"
                        onPointerDown={(event) => handlePointerDown(event, id)}
                        onPointerMove={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            moveSide(event, id);
                          }
                        }}
                      />
                    ))}
                    {sideLines.map(({ id, start, end }) => (
                      <line
                        key={`side-visible-${id}`}
                        className={`manual-side-line manual-side-line-${id}`}
                        x1={start.x * 100}
                        y1={start.y * 100}
                        x2={end.x * 100}
                        y2={end.y * 100}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                ) : null}
                {(Object.entries(reference.points) as Array<
                  [CornerId, NormalizedCornerPoint]
                >).map(([id, point]) => (
                  <span
                    key={id}
                    className="manual-corner-point manual-corner-point-fixed manual-corner-point-original"
                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                    title={`${id.toUpperCase()} detected or triangulated point`}
                  />
                ))}
                {(Object.entries(adjustedCorners) as Array<
                  [CornerId, NormalizedCornerPoint]
                >).map(([id, point]) => (
                  <span
                    key={`adjusted-${id}`}
                    className="manual-corner-point manual-corner-point-fixed manual-corner-point-adjusted"
                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                    title={`${id.toUpperCase()} adjusted side intersection`}
                  />
                ))}
              </div>
            </div>
            <p className="subtle-text">
              Bounds: left {(sides.left * 100).toFixed(1)}%, top{" "}
              {(sides.top * 100).toFixed(1)}%, right{" "}
              {(sides.right * 100).toFixed(1)}%, bottom{" "}
              {(sides.bottom * 100).toFixed(1)}%
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
            disabled={!reference || loading}
            onClick={finalize}
          >
            Finalize sides and reprocess triangulated files
          </button>
        </footer>
      </section>
    </div>
  );
}
