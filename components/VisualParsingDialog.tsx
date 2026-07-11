"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { RoiBoxVisual } from "@/lib/omr/roiCalibration";
import type { CornerSnapshot } from "@/types/omr";
import type {
  CornerWindowVisual,
  VisualParseStep
} from "@/lib/omr/buildVisualParsingSteps";

interface VisualParsingDialogProps {
  isOpen: boolean;
  loading: boolean;
  stage: string | null;
  error: string | null;
  steps: VisualParseStep[];
  onApplyCornerWindows: (windows: CornerWindowVisual[]) => void;
  onCaptureCornerSnapshots: (
    snapshots: Partial<Record<CornerWindowVisual["id"], CornerSnapshot>>
  ) => void;
  onApplyRoiBoxes: (boxes: RoiBoxVisual[]) => void | Promise<void>;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const otsuThreshold = (grayscale: number[]): number => {
  const histogram = new Array<number>(256).fill(0);
  for (const value of grayscale) {
    histogram[Math.min(255, Math.max(0, Math.round(value)))] += 1;
  }

  let totalWeighted = 0;
  for (let i = 0; i < 256; i += 1) {
    totalWeighted += i * histogram[i];
  }

  let backgroundWeight = 0;
  let backgroundWeighted = 0;
  let bestThreshold = 127;
  let maxVariance = -1;
  const total = grayscale.length;

  for (let i = 0; i < 256; i += 1) {
    backgroundWeight += histogram[i];
    if (backgroundWeight === 0) {
      continue;
    }
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) {
      break;
    }

    backgroundWeighted += i * histogram[i];
    const meanBackground = backgroundWeighted / backgroundWeight;
    const meanForeground = (totalWeighted - backgroundWeighted) / foregroundWeight;
    const variance =
      backgroundWeight * foregroundWeight * (meanBackground - meanForeground) * (meanBackground - meanForeground);
    if (variance > maxVariance) {
      maxVariance = variance;
      bestThreshold = i;
    }
  }

  return bestThreshold;
};

const computeSnapshotCentroid = (
  grayscale: number[],
  width: number,
  height: number
): { x: number; y: number } | null => {
  if (grayscale.length !== width * height) {
    return null;
  }
  const threshold = otsuThreshold(grayscale);
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = grayscale[y * width + x];
      if (value <= threshold) {
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }
  if (count < width * height * 0.01) {
    return null;
  }
  return {
    x: sumX / count,
    y: sumY / count
  };
};

interface CornerWindowEditorProps {
  baseImageDataUrl: string;
  initialCornerWindows: CornerWindowVisual[];
  onApplyCornerWindows: (windows: CornerWindowVisual[]) => void;
  onCaptureCornerSnapshots: (
    snapshots: Partial<Record<CornerWindowVisual["id"], CornerSnapshot>>
  ) => void;
}

interface RoiBoxEditorProps {
  baseImageDataUrl: string;
  initialRoiBoxes: RoiBoxVisual[];
  onApplyRoiBoxes: (boxes: RoiBoxVisual[]) => void | Promise<void>;
  onDraftRoiBoxesChange: (boxes: RoiBoxVisual[]) => void;
}

type DragMode = "move" | "resize-tl" | "resize-tr" | "resize-br" | "resize-bl";

const applyDragToRect = (
  rect: { x: number; y: number; w: number; h: number },
  mode: DragMode,
  dx: number,
  dy: number,
  minSize: number
) => {
  if (mode === "move") {
    return {
      ...rect,
      x: clamp(rect.x + dx, 0, 1 - rect.w),
      y: clamp(rect.y + dy, 0, 1 - rect.h)
    };
  }

  let x1 = rect.x;
  let y1 = rect.y;
  let x2 = rect.x + rect.w;
  let y2 = rect.y + rect.h;

  if (mode === "resize-tl") {
    x1 += dx;
    y1 += dy;
  } else if (mode === "resize-tr") {
    x2 += dx;
    y1 += dy;
  } else if (mode === "resize-br") {
    x2 += dx;
    y2 += dy;
  } else {
    x1 += dx;
    y2 += dy;
  }

  x1 = clamp(x1, 0, 1);
  y1 = clamp(y1, 0, 1);
  x2 = clamp(x2, 0, 1);
  y2 = clamp(y2, 0, 1);

  if (x2 - x1 < minSize) {
    if (mode === "resize-tl" || mode === "resize-bl") {
      x1 = x2 - minSize;
    } else {
      x2 = x1 + minSize;
    }
  }
  if (y2 - y1 < minSize) {
    if (mode === "resize-tl" || mode === "resize-tr") {
      y1 = y2 - minSize;
    } else {
      y2 = y1 + minSize;
    }
  }

  x1 = clamp(x1, 0, 1 - minSize);
  y1 = clamp(y1, 0, 1 - minSize);
  x2 = clamp(x2, x1 + minSize, 1);
  y2 = clamp(y2, y1 + minSize, 1);

  return {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1
  };
};

function CornerWindowEditor({
  baseImageDataUrl,
  initialCornerWindows,
  onApplyCornerWindows,
  onCaptureCornerSnapshots
}: CornerWindowEditorProps) {
  const [draftCornerWindows, setDraftCornerWindows] = useState(initialCornerWindows);
  const [dragState, setDragState] = useState<{
    id: CornerWindowVisual["id"];
    mode: DragMode;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    containerWidth: number;
    containerHeight: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      const dx = (event.clientX - dragState.startClientX) / Math.max(1, dragState.containerWidth);
      const dy =
        (event.clientY - dragState.startClientY) / Math.max(1, dragState.containerHeight);

      setDraftCornerWindows((current) =>
        current.map((cornerWindow) => {
          if (cornerWindow.id !== dragState.id) {
            return cornerWindow;
          }
          const next = applyDragToRect(
            {
              x: dragState.startX,
              y: dragState.startY,
              w: dragState.startW,
              h: dragState.startH
            },
            dragState.mode,
            dx,
            dy,
            0.02
          );
          return { ...cornerWindow, x: next.x, y: next.y, w: next.w, h: next.h };
        })
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === dragState.pointerId) {
        setDragState(null);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragState]);

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cornerWindow: CornerWindowVisual,
    mode: DragMode
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setDragState({
      id: cornerWindow.id,
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      containerWidth: rect.width,
      containerHeight: rect.height,
      startX: cornerWindow.x,
      startY: cornerWindow.y,
      startW: cornerWindow.w,
      startH: cornerWindow.h
    });
  };

  const captureCornerSnapshots = async () => {
    try {
      const image = new Image();
      image.src = baseImageDataUrl;
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, image.width);
      canvas.height = Math.max(1, image.height);
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.drawImage(image, 0, 0);

      const snapshots: Partial<Record<CornerWindowVisual["id"], CornerSnapshot>> = {};
      for (const cornerWindow of draftCornerWindows) {
        const x = clamp(Math.round(cornerWindow.x * image.width), 0, image.width - 1);
        const y = clamp(Math.round(cornerWindow.y * image.height), 0, image.height - 1);
        const width = clamp(Math.round(cornerWindow.w * image.width), 8, image.width - x);
        const height = clamp(Math.round(cornerWindow.h * image.height), 8, image.height - y);
        const data = context.getImageData(x, y, width, height).data;
        const grayscale = new Array<number>(width * height);
        for (let index = 0; index < data.length; index += 4) {
          grayscale[index / 4] = Math.round(
            data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
          );
        }
        const centroid = computeSnapshotCentroid(grayscale, width, height);
        snapshots[cornerWindow.id] = {
          id: cornerWindow.id,
          width,
          height,
          grayscale,
          centroidX: centroid?.x,
          centroidY: centroid?.y
        };
      }
      onCaptureCornerSnapshots(snapshots);
    } catch {
      // The debug UI should remain non-blocking if capture fails.
    }
  };

  return (
    <section className="step-card">
      <h3>Corner box editor</h3>
      <p className="subtle-text">
        Drag the corner windows to adjust where the detector searches for corner squares.
      </p>
      <div className="corner-editor-surface" ref={editorRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={baseImageDataUrl} alt="Corner editor base" />
        {draftCornerWindows.map((cornerWindow) => (
          <div
            key={cornerWindow.id}
            className="corner-window-box"
            style={{
              left: `${cornerWindow.x * 100}%`,
              top: `${cornerWindow.y * 100}%`,
              width: `${cornerWindow.w * 100}%`,
              height: `${cornerWindow.h * 100}%`
            }}
          >
            <span className="corner-window-label">{cornerWindow.id.toUpperCase()}</span>
            <span className="corner-window-dot" />
            <button
              className="region-move-hitbox"
              onPointerDown={(event) => beginDrag(event, cornerWindow, "move")}
            />
            <button
              className="region-corner-handle region-corner-handle-tl"
              onPointerDown={(event) => beginDrag(event, cornerWindow, "resize-tl")}
            />
            <button
              className="region-corner-handle region-corner-handle-tr"
              onPointerDown={(event) => beginDrag(event, cornerWindow, "resize-tr")}
            />
            <button
              className="region-corner-handle region-corner-handle-br"
              onPointerDown={(event) => beginDrag(event, cornerWindow, "resize-br")}
            />
            <button
              className="region-corner-handle region-corner-handle-bl"
              onPointerDown={(event) => beginDrag(event, cornerWindow, "resize-bl")}
            />
          </div>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => onApplyCornerWindows(draftCornerWindows)}>Apply Corner Boxes</button>
        <button onClick={() => void captureCornerSnapshots()}>Capture Corner Snapshots</button>
        <button
          onClick={() => {
            setDraftCornerWindows(initialCornerWindows);
          }}
        >
          Reset
        </button>
      </div>
    </section>
  );
}

function RoiBoxEditor({
  baseImageDataUrl,
  initialRoiBoxes,
  onApplyRoiBoxes,
  onDraftRoiBoxesChange
}: RoiBoxEditorProps) {
  const [draftRoiBoxes, setDraftRoiBoxes] = useState(initialRoiBoxes);
  const [dragState, setDragState] = useState<{
    id: RoiBoxVisual["id"];
    mode: DragMode;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    containerWidth: number;
    containerHeight: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onDraftRoiBoxesChange(draftRoiBoxes);
  }, [draftRoiBoxes, onDraftRoiBoxesChange]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      const dx = (event.clientX - dragState.startClientX) / Math.max(1, dragState.containerWidth);
      const dy =
        (event.clientY - dragState.startClientY) / Math.max(1, dragState.containerHeight);

      setDraftRoiBoxes((current) =>
        current.map((box) => {
          if (box.id !== dragState.id) {
            return box;
          }
          const next = applyDragToRect(
            {
              x: dragState.startX,
              y: dragState.startY,
              w: dragState.startW,
              h: dragState.startH
            },
            dragState.mode,
            dx,
            dy,
            0.04
          );
          return { ...box, x: next.x, y: next.y, w: next.w, h: next.h };
        })
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === dragState.pointerId) {
        setDragState(null);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragState]);

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    box: RoiBoxVisual,
    mode: DragMode
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setDragState({
      id: box.id,
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      containerWidth: rect.width,
      containerHeight: rect.height,
      startX: box.x,
      startY: box.y,
      startW: box.w,
      startH: box.h
    });
  };

  const labelMap: Record<RoiBoxVisual["id"], string> = {
    studentId: "ID",
    examCode: "CODE",
    examSet: "SET",
    answersCol1: "A1",
    answersCol2: "A2",
    answersCol3: "A3"
  };

  return (
    <section className="step-card">
      <h3>ROI editor</h3>
      <p className="subtle-text">
        Drag each region to align extraction zones for student fields and answer columns.
      </p>
      <div className="corner-editor-surface" ref={editorRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={baseImageDataUrl} alt="ROI editor base" />
        {draftRoiBoxes.map((box) => (
          <div
            key={box.id}
            className="corner-window-box"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`
            }}
          >
            <span className="corner-window-label">{labelMap[box.id]}</span>
            <span className="corner-window-dot" />
            <button
              className="region-move-hitbox"
              onPointerDown={(event) => beginDrag(event, box, "move")}
            />
            <button
              className="region-corner-handle region-corner-handle-tl"
              onPointerDown={(event) => beginDrag(event, box, "resize-tl")}
            />
            <button
              className="region-corner-handle region-corner-handle-tr"
              onPointerDown={(event) => beginDrag(event, box, "resize-tr")}
            />
            <button
              className="region-corner-handle region-corner-handle-br"
              onPointerDown={(event) => beginDrag(event, box, "resize-br")}
            />
            <button
              className="region-corner-handle region-corner-handle-bl"
              onPointerDown={(event) => beginDrag(event, box, "resize-bl")}
            />
          </div>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => void onApplyRoiBoxes(draftRoiBoxes)}>Apply ROI Boxes</button>
        <button
          onClick={() => {
            setDraftRoiBoxes(initialRoiBoxes);
          }}
        >
          Reset
        </button>
      </div>
    </section>
  );
}

export function VisualParsingDialog({
  isOpen,
  loading,
  stage,
  error,
  steps,
  onApplyCornerWindows,
  onCaptureCornerSnapshots,
  onApplyRoiBoxes,
  onClose
}: VisualParsingDialogProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [roiDraftBoxes, setRoiDraftBoxes] = useState<RoiBoxVisual[] | null>(null);
  const wizardPages = ["corners", "centroids", "transform", "roi", "readAreas"] as const;
  const cornerStep = useMemo(
    () => steps.find((step) => step.id === "corners" && step.cornerWindows?.length),
    [steps]
  );
  const centroidStep = useMemo(() => steps.find((step) => step.id === "corner-centroids"), [steps]);
  const transformStep = useMemo(() => steps.find((step) => step.id === "rectified"), [steps]);
  const roiStep = useMemo(
    () => steps.find((step) => step.id === "regions" && step.roiBoxes?.length),
    [steps]
  );
  const readAreasStep = useMemo(() => steps.find((step) => step.id === "read-areas"), [steps]);

  if (!isOpen) {
    return null;
  }

  const handleClose = () => {
    setPageIndex(0);
    setNavigationBusy(false);
    setRoiDraftBoxes(null);
    onClose();
  };

  const currentPage = wizardPages[Math.min(pageIndex, wizardPages.length - 1)];
  const pageTitle =
    currentPage === "corners"
      ? "Page 1: Corner Regions"
      : currentPage === "centroids"
        ? "Page 2: Corner Centroids"
        : currentPage === "transform"
          ? "Page 3: Perspective Transform"
          : currentPage === "roi"
            ? "Page 4: ROI Selection"
            : "Page 5: Detailed Read Areas";

  const canGoBack = pageIndex > 0;
  const canGoNext = pageIndex < wizardPages.length - 1;
  const canInteract = !loading && !navigationBusy;

  const handleNext = async () => {
    if (!canGoNext || !canInteract) {
      return;
    }
    if (currentPage === "roi" && roiDraftBoxes && roiDraftBoxes.length > 0) {
      setNavigationBusy(true);
      try {
        await onApplyRoiBoxes(roiDraftBoxes);
      } finally {
        setNavigationBusy(false);
      }
    }
    setPageIndex((value) => Math.min(wizardPages.length - 1, value + 1));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true">
        <header className="modal-header">
          <h2>Visual Parse Debug</h2>
          <button onClick={handleClose}>Close</button>
        </header>
        <div className="wizard-topline">
          <strong>{pageTitle}</strong>
          <span className="subtle-text">
            Step {pageIndex + 1} / {wizardPages.length}
          </span>
        </div>
        {loading ? <p className="subtle-text">{stage ?? "Preparing visual steps..."}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {!loading && !error && steps.length === 0 ? (
          <p className="subtle-text">No visual steps available yet.</p>
        ) : null}

        <div className="wizard-page">
          {!loading && !error && currentPage === "corners" ? (
            cornerStep?.baseImageDataUrl && (cornerStep.cornerWindows?.length ?? 0) > 0 ? (
              <CornerWindowEditor
                key={cornerStep.imageDataUrl}
                baseImageDataUrl={cornerStep.baseImageDataUrl}
                initialCornerWindows={cornerStep.cornerWindows ?? []}
                onApplyCornerWindows={onApplyCornerWindows}
                onCaptureCornerSnapshots={onCaptureCornerSnapshots}
              />
            ) : (
              <p className="subtle-text">Corner step is not available for this image.</p>
            )
          ) : null}

          {!loading && !error && currentPage === "transform" ? (
            transformStep ? (
              <article key={transformStep.id} className="step-card wizard-image-page">
                <h3>{transformStep.title}</h3>
                <p className="subtle-text">{transformStep.description}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={transformStep.imageDataUrl} alt={transformStep.title} />
              </article>
            ) : (
              <p className="subtle-text">Perspective transform preview is not available.</p>
            )
          ) : null}

          {!loading && !error && currentPage === "centroids" ? (
            centroidStep ? (
              <article key={centroidStep.id} className="step-card wizard-image-page">
                <h3>{centroidStep.title}</h3>
                <p className="subtle-text">{centroidStep.description}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={centroidStep.imageDataUrl} alt={centroidStep.title} />
              </article>
            ) : (
              <p className="subtle-text">Corner centroid step is not available.</p>
            )
          ) : null}

          {!loading && !error && currentPage === "roi" ? (
            roiStep?.baseImageDataUrl && (roiStep.roiBoxes?.length ?? 0) > 0 ? (
              <RoiBoxEditor
                key={roiStep.imageDataUrl}
                baseImageDataUrl={roiStep.baseImageDataUrl}
                initialRoiBoxes={roiStep.roiBoxes ?? []}
                onApplyRoiBoxes={onApplyRoiBoxes}
                onDraftRoiBoxesChange={setRoiDraftBoxes}
              />
            ) : (
              <p className="subtle-text">ROI step is not available for this image.</p>
            )
          ) : null}

          {!loading && !error && currentPage === "readAreas" ? (
            readAreasStep ? (
              <article key={readAreasStep.id} className="step-card wizard-image-page">
                <h3>{readAreasStep.title}</h3>
                <p className="subtle-text">{readAreasStep.description}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={readAreasStep.imageDataUrl} alt={readAreasStep.title} />
              </article>
            ) : (
              <p className="subtle-text">Detailed read-area map is not available.</p>
            )
          ) : null}
        </div>

        <div className="wizard-nav">
          <button
            disabled={!canGoBack || !canInteract}
            onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
          >
            Back
          </button>
          {canGoNext ? (
            <button disabled={!canInteract} onClick={() => void handleNext()}>
              {navigationBusy ? "Applying..." : "Next"}
            </button>
          ) : (
            <button disabled={!canInteract} onClick={handleClose}>
              Done
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
