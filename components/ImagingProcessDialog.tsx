"use client";

import { effectiveAnswerForOverlay } from "@/lib/grading/answerOverrides";
import { deriveRoiBoxesFromTemplate } from "@/lib/omr/roiCalibration";
import type { AnswerOverrideMap } from "@/types/grading";
import type {
  ChoiceLabel,
  ImagingProcessStep,
  OMRResultJson,
  OMRTemplate,
  PaperDetectionDiagnostics
} from "@/types/omr";

interface ImagingProcessDialogProps {
  fileName: string;
  steps: ImagingProcessStep[];
  loading: boolean;
  loadingStage?: string;
  error: string | null;
  blockingReason?: string;
  result: OMRResultJson | null;
  overrides: AnswerOverrideMap;
  template: OMRTemplate;
  paperDetection?: PaperDetectionDiagnostics;
  columnAlignmentOffsets: Array<{ dx: number; dy: number }>;
  onAnswerClick: (question: number, choice: ChoiceLabel) => void;
  onResetOverrides: () => void;
  onClose: () => void;
}

const choices: ChoiceLabel[] = ["A", "B", "C", "D"];

const columnOffsetForQuestion = (
  question: number,
  offsets: Array<{ dx: number; dy: number }>
) => offsets[question <= 35 ? 0 : question <= 70 ? 1 : 2] ?? { dx: 0, dy: 0 };

export function ImagingProcessDialog({
  fileName,
  steps,
  loading,
  loadingStage,
  error,
  blockingReason,
  result,
  overrides,
  template,
  paperDetection,
  columnAlignmentOffsets,
  onAnswerClick,
  onResetOverrides,
  onClose
}: ImagingProcessDialogProps) {
  const roiBoxes = deriveRoiBoxesFromTemplate(template);
  const answerByQuestion = new Map(
    (result?.answers ?? []).map((answer) => [answer.q, answer])
  );
  const overrideCount = Object.keys(overrides).length;

  return (
    <div
      className="override-backdrop imaging-process-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="imaging-process-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="imaging-process-title"
      >
        <header className="modal-header imaging-process-header">
          <div>
            <h2 id="imaging-process-title">Imaging Process — {fileName}</h2>
            <p>
              {paperDetection?.strategy === "paper-crop"
                ? "Paper-first localization"
                : "Strict full-photo fiducial fallback"}
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {loading ? (
          <div className="imaging-process-loading" role="status">
            <span className="spinner" />
            <p>{loadingStage ?? "Generating the original-to-final OpenCV stages…"}</p>
          </div>
        ) : null}
        {error ? <p className="error grader-error">{error}</p> : null}
        {blockingReason ? (
          <p className="imaging-process-blocking">
            Processing stopped: {blockingReason}
          </p>
        ) : null}

        {!loading && !error ? (
          <div className="imaging-process-timeline">
            {steps.map((step, index) => {
              const isFinal = step.id === "final-detection";
              return (
                <article
                  className="imaging-process-step"
                  data-step={step.id}
                  key={step.id}
                >
                  <div className="imaging-process-rail" aria-hidden="true">
                    <span>{index + 1}</span>
                  </div>
                  <div className="imaging-process-card">
                    <header>
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                    </header>
                    {isFinal && result ? (
                      <>
                        <div className="imaging-legend" aria-label="Detection legend">
                          <span className="is-selected">Confident/selected</span>
                          <span className="is-uncertain">Blank or ambiguous</span>
                          <span className="is-region">Recognized ROI</span>
                          <span className="is-override">Manual override</span>
                        </div>
                        <div className="imaging-final-stage">
                          {/* Blob URLs are generated locally and are not supported by next/image. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={step.imageUrl} alt={step.title} />
                          <div className="imaging-roi-layer" aria-hidden="true">
                            {roiBoxes.map((box) => (
                              <span
                                className="imaging-roi-box"
                                key={box.id}
                                style={{
                                  left: `${box.x * 100}%`,
                                  top: `${box.y * 100}%`,
                                  width: `${box.w * 100}%`,
                                  height: `${box.h * 100}%`
                                }}
                              />
                            ))}
                          </div>
                          <div
                            className="imaging-answer-hotspots"
                            aria-label="Interactive answer override layer"
                          >
                            {template.answers.flatMap((answerRegion) => {
                              const answer = answerByQuestion.get(answerRegion.question);
                              if (!answer) return [];
                              const effective = effectiveAnswerForOverlay(answer, overrides);
                              const offset = columnOffsetForQuestion(
                                answerRegion.question,
                                columnAlignmentOffsets
                              );
                              const overridden = Object.prototype.hasOwnProperty.call(
                                overrides,
                                answerRegion.question
                              );
                              return choices.map((choice) => {
                                const bubble = answerRegion.choices[choice];
                                const active = effective === choice;
                                const uncertain =
                                  effective === null &&
                                  (answer.markState === "ambiguous" ||
                                    answer.markState === "blank" ||
                                    answer.selected.length !== 1);
                                return (
                                  <button
                                    type="button"
                                    key={`${answerRegion.question}-${choice}`}
                                    className={`imaging-answer-checkbox${
                                      active ? " is-active" : ""
                                    }${uncertain ? " is-uncertain" : ""}${
                                      overridden ? " is-overridden" : ""
                                    }`}
                                    style={{
                                      left: `${(bubble.x + offset.dx) * 100}%`,
                                      top: `${(bubble.y + offset.dy) * 100}%`,
                                      width: `${bubble.w * 100}%`,
                                      height: `${bubble.h * 100}%`
                                    }}
                                    title={`Question ${answerRegion.question}, ${choice}; ${
                                      active ? "selected" : "not selected"
                                    }; confidence ${Math.round(answer.confidence * 100)}%`}
                                    aria-label={`Question ${answerRegion.question}, choice ${choice}${
                                      active ? ", selected" : ""
                                    }`}
                                    aria-pressed={active}
                                    onClick={() =>
                                      onAnswerClick(answerRegion.question, choice)
                                    }
                                  />
                                );
                              });
                            })}
                          </div>
                        </div>
                        <div className="imaging-process-actions">
                          <span>
                            {overrideCount} manual override
                            {overrideCount === 1 ? "" : "s"}
                          </span>
                          <button
                            type="button"
                            disabled={overrideCount === 0}
                            onClick={onResetOverrides}
                          >
                            Reset all to detected
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="imaging-process-visual">
                        {/* Blob URLs are generated locally and are not supported by next/image. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          className="imaging-process-image"
                          src={step.imageUrl}
                          alt={step.title}
                        />
                        {step.id === "paper" && paperDetection?.polygon ? (
                          <svg
                            className="imaging-paper-outline"
                            viewBox="0 0 1 1"
                            preserveAspectRatio="none"
                            aria-label="Detected paper outline"
                          >
                            <polygon
                              points={paperDetection.polygon
                                .map((point) => `${point.x},${point.y}`)
                                .join(" ")}
                            />
                          </svg>
                        ) : null}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
