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
  onApplyRoiBoxes: (boxes: RoiBoxVisual[]) => void;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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
  onApplyRoiBoxes: (boxes: RoiBoxVisual[]) => void;
}

function CornerWindowEditor({
  baseImageDataUrl,
  initialCornerWindows,
  onApplyCornerWindows,
  onCaptureCornerSnapshots
}: CornerWindowEditorProps) {
  const [draftCornerWindows, setDraftCornerWindows] = useState(initialCornerWindows);
  const [dragState, setDragState] = useState<{
    id: CornerWindowVisual["id"];
    pointerId: number;
    startClientX: number;
    startClientY: number;
    containerWidth: number;
    containerHeight: number;
    startX: number;
    startY: number;
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

          const nextX = clamp(dragState.startX + dx, 0, 1 - cornerWindow.w);
          const nextY = clamp(dragState.startY + dy, 0, 1 - cornerWindow.h);
          return { ...cornerWindow, x: nextX, y: nextY };
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
    cornerWindow: CornerWindowVisual
  ) => {
    event.preventDefault();
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setDragState({
      id: cornerWindow.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      containerWidth: rect.width,
      containerHeight: rect.height,
      startX: cornerWindow.x,
      startY: cornerWindow.y
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
        snapshots[cornerWindow.id] = {
          id: cornerWindow.id,
          width,
          height,
          grayscale
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
          <button
            key={cornerWindow.id}
            className="corner-window-box"
            style={{
              left: `${cornerWindow.x * 100}%`,
              top: `${cornerWindow.y * 100}%`,
              width: `${cornerWindow.w * 100}%`,
              height: `${cornerWindow.h * 100}%`
            }}
            onPointerDown={(event) => beginDrag(event, cornerWindow)}
          >
            <span className="corner-window-label">{cornerWindow.id.toUpperCase()}</span>
            <span className="corner-window-dot" />
          </button>
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

function RoiBoxEditor({ baseImageDataUrl, initialRoiBoxes, onApplyRoiBoxes }: RoiBoxEditorProps) {
  const [draftRoiBoxes, setDraftRoiBoxes] = useState(initialRoiBoxes);
  const [dragState, setDragState] = useState<{
    id: RoiBoxVisual["id"];
    pointerId: number;
    startClientX: number;
    startClientY: number;
    containerWidth: number;
    containerHeight: number;
    startX: number;
    startY: number;
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

      setDraftRoiBoxes((current) =>
        current.map((box) => {
          if (box.id !== dragState.id) {
            return box;
          }
          const nextX = clamp(dragState.startX + dx, 0, 1 - box.w);
          const nextY = clamp(dragState.startY + dy, 0, 1 - box.h);
          return { ...box, x: nextX, y: nextY };
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

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, box: RoiBoxVisual) => {
    event.preventDefault();
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setDragState({
      id: box.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      containerWidth: rect.width,
      containerHeight: rect.height,
      startX: box.x,
      startY: box.y
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
          <button
            key={box.id}
            className="corner-window-box"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`
            }}
            onPointerDown={(event) => beginDrag(event, box)}
          >
            <span className="corner-window-label">{labelMap[box.id]}</span>
            <span className="corner-window-dot" />
          </button>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => onApplyRoiBoxes(draftRoiBoxes)}>Apply ROI Boxes</button>
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
  const wizardPages = ["corners", "transform", "roi"] as const;
  const cornerStep = useMemo(
    () => steps.find((step) => step.id === "corners" && step.cornerWindows?.length),
    [steps]
  );
  const transformStep = useMemo(() => steps.find((step) => step.id === "rectified"), [steps]);
  const roiStep = useMemo(
    () => steps.find((step) => step.id === "regions" && step.roiBoxes?.length),
    [steps]
  );

  if (!isOpen) {
    return null;
  }

  const handleClose = () => {
    setPageIndex(0);
    onClose();
  };

  const currentPage = wizardPages[Math.min(pageIndex, wizardPages.length - 1)];
  const pageTitle =
    currentPage === "corners"
      ? "Page 1: Corner Regions"
      : currentPage === "transform"
        ? "Page 2: Perspective Transform"
        : "Page 3: ROI Selection";

  const canGoBack = pageIndex > 0;
  const canGoNext = pageIndex < wizardPages.length - 1;

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

          {!loading && !error && currentPage === "roi" ? (
            roiStep?.baseImageDataUrl && (roiStep.roiBoxes?.length ?? 0) > 0 ? (
              <RoiBoxEditor
                key={roiStep.imageDataUrl}
                baseImageDataUrl={roiStep.baseImageDataUrl}
                initialRoiBoxes={roiStep.roiBoxes ?? []}
                onApplyRoiBoxes={onApplyRoiBoxes}
              />
            ) : (
              <p className="subtle-text">ROI step is not available for this image.</p>
            )
          ) : null}
        </div>

        <div className="wizard-nav">
          <button disabled={!canGoBack} onClick={() => setPageIndex((value) => Math.max(0, value - 1))}>
            Back
          </button>
          {canGoNext ? (
            <button
              onClick={() =>
                setPageIndex((value) => Math.min(wizardPages.length - 1, value + 1))
              }
            >
              Next
            </button>
          ) : (
            <button onClick={handleClose}>Done</button>
          )}
        </div>
      </section>
    </div>
  );
}
