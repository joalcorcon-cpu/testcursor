"use client";

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  deriveManualCornerCalibration,
  type CornerId,
  type CornerPointMap,
  type NormalizedCornerPoint
} from "@/lib/omr/manualCornerCalibration";
import {
  projectRectifiedPoint,
  unprojectSourcePoint
} from "@/lib/omr/projectRectifiedOverlay";
import type { RoiBoxVisual } from "@/lib/omr/roiCalibration";
import type {
  ManualCornerCalibration,
  ManualSideCalibration
} from "@/types/omr";

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
    selection: ManualCalibrationSelection,
    referenceFileId: string
  ) => void;
  onClose: () => void;
}

type SideId = keyof ManualSideCalibration;
export interface ManualCalibrationSelection {
  corner: ManualCornerCalibration;
  sides: ManualSideCalibration;
}

const cornerOptions: Array<{ id: CornerId; label: string }> = [
  { id: "tl", label: "Upper left" },
  { id: "tr", label: "Upper right" },
  { id: "br", label: "Lower right" },
  { id: "bl", label: "Lower left" }
];

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
  const [cornerId, setCornerId] = useState<CornerId>("br");
  const [fileId, setFileId] = useState(
    files.find((file) => file.triangulated)?.id ?? files[0]?.id ?? ""
  );
  const [reference, setReference] = useState<PreparedCornerReference | null>(null);
  const [manualPoint, setManualPoint] = useState<NormalizedCornerPoint | null>(null);
  const [sides, setSides] = useState<ManualSideCalibration>(defaultSides);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cornerAdjustedCorners: CornerPointMap | null =
    reference && manualPoint
      ? { ...reference.points, [cornerId]: manualPoint }
      : reference?.points ?? null;
  const adjustedCorners: CornerPointMap | null = cornerAdjustedCorners
    ? {
        tl: projectRectifiedPoint(cornerAdjustedCorners, {
          x: sides.left,
          y: sides.top
        }),
        tr: projectRectifiedPoint(cornerAdjustedCorners, {
          x: sides.right,
          y: sides.top
        }),
        br: projectRectifiedPoint(cornerAdjustedCorners, {
          x: sides.right,
          y: sides.bottom
        }),
        bl: projectRectifiedPoint(cornerAdjustedCorners, {
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
      setManualPoint(prepared.points[cornerId]);
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
    const overlay = event.currentTarget.ownerSVGElement;
    if (!overlay || !cornerAdjustedCorners) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    try {
      const sheetPoint = unprojectSourcePoint(cornerAdjustedCorners, {
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

  const movePoint = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const stage = event.currentTarget.parentElement;
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    setManualPoint({
      x: clampSide((event.clientX - rect.left) / rect.width),
      y: clampSide((event.clientY - rect.top) / rect.height)
    });
  };

  const handlePointPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    movePoint(event);
  };

  const finalize = () => {
    if (!reference || !manualPoint || !fileId) {
      setError("Load a reference and position the calibration first.");
      return;
    }
    onFinalize(
      {
        corner: deriveManualCornerCalibration(
          reference.points,
          cornerId,
          manualPoint
        ),
        sides
      },
      fileId
    );
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
            <h2 id="manual-corner-title">Adjust corner and sheet sides</h2>
            <p className="subtle-text">
              Move the selected inferred corner and all four boundaries in the
              same calibration.
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
                setManualPoint(reference?.points[nextCornerId] ?? null);
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
              Drag the blue corner point and any blue side. Both can move into
              the padded area outside the image. The final quadrilateral and ROIs
              update dynamically.
            </p>
            <div className="manual-corner-canvas">
              <div className="manual-corner-image-stage">
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
                {manualPoint ? (
                  <button
                    type="button"
                    className="manual-corner-point manual-corner-point-active"
                    style={{
                      left: `${manualPoint.x * 100}%`,
                      top: `${manualPoint.y * 100}%`
                    }}
                    aria-label={`Move ${cornerId.toUpperCase()} corner`}
                    title="Drag adjusted corner"
                    onPointerDown={handlePointPointerDown}
                    onPointerMove={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        movePoint(event);
                      }
                    }}
                  />
                ) : null}
              </div>
            </div>
            <p className="subtle-text">
              Corner: {manualPoint ? `${(manualPoint.x * 100).toFixed(1)}% × ${(
                manualPoint.y * 100
              ).toFixed(1)}%` : "not set"} · Bounds: left{" "}
              {(sides.left * 100).toFixed(1)}%, top{" "}
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
            disabled={!reference || !manualPoint || loading}
            onClick={finalize}
          >
            Finalize adjustment and reprocess triangulated files
          </button>
        </footer>
      </section>
    </div>
  );
}
