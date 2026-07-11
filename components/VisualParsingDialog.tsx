"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
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
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface CornerWindowEditorProps {
  baseImageDataUrl: string;
  initialCornerWindows: CornerWindowVisual[];
  onApplyCornerWindows: (windows: CornerWindowVisual[]) => void;
}

function CornerWindowEditor({
  baseImageDataUrl,
  initialCornerWindows,
  onApplyCornerWindows
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

export function VisualParsingDialog({
  isOpen,
  loading,
  stage,
  error,
  steps,
  onApplyCornerWindows,
  onClose
}: VisualParsingDialogProps) {
  const cornerStep = useMemo(
    () => steps.find((step) => step.id === "corners" && step.cornerWindows?.length),
    [steps]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true">
        <header className="modal-header">
          <h2>Visual Parse Debug</h2>
          <button onClick={onClose}>Close</button>
        </header>
        {loading ? <p className="subtle-text">{stage ?? "Preparing visual steps..."}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {!loading && !error && steps.length === 0 ? (
          <p className="subtle-text">No visual steps available yet.</p>
        ) : null}
        {cornerStep?.baseImageDataUrl && (cornerStep.cornerWindows?.length ?? 0) > 0 ? (
          <CornerWindowEditor
            key={cornerStep.imageDataUrl}
            baseImageDataUrl={cornerStep.baseImageDataUrl}
            initialCornerWindows={cornerStep.cornerWindows ?? []}
            onApplyCornerWindows={onApplyCornerWindows}
          />
        ) : null}
        <div className="step-list">
          {steps.map((step) => (
            <article key={step.id} className="step-card">
              <h3>{step.title}</h3>
              <p className="subtle-text">{step.description}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={step.imageDataUrl} alt={step.title} />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
