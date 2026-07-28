"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { AppDashboardShell } from "@/components/AppDashboardShell";
import { ImagingProcessDialog } from "@/components/ImagingProcessDialog";
import { examCatalog, getExamById } from "@/lib/exams/examCatalog";
import {
  applyAnswerBubbleClick,
  resetAnswerOverrides
} from "@/lib/grading/answerOverrides";
import { gradeSheet } from "@/lib/grading/gradeSheet";
import { buildVisualParsingSteps } from "@/lib/omr/buildVisualParsingSteps";
import { prepareImageForScan } from "@/lib/omr/prepareImageForScan";
import {
  buildGradingVisualizationInWorker,
  processSheetFileInWorker,
  warmupOmrWorker
} from "@/lib/omr/processSheetInWorker";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import { loadBundledCornerSnapshots } from "@/lib/templates/loadBundledCornerSnapshots";
import type { AnswerOverrideMap, SheetGrade } from "@/types/grading";
import type {
  ChoiceLabel,
  ImagingProcessStep,
  OMRResultJson,
  OMRTemplate,
  PaperDetectionDiagnostics
} from "@/types/omr";

type QueueStatus = "queued" | "processing" | "done" | "error";

interface GraderQueueItem {
  id: string;
  file: File;
  examId: string;
  status: QueueStatus;
  result: OMRResultJson | null;
  overrides: AnswerOverrideMap;
  detail?: string;
}

interface ReviewState {
  fileId: string | null;
  loading: boolean;
  error: string | null;
  overlayUrl: string | null;
}

interface ImagingState {
  fileId: string | null;
  loading: boolean;
  error: string | null;
  steps: ImagingProcessStep[];
  blockingReason?: string;
  paperDetection?: PaperDetectionDiagnostics;
  columnAlignmentOffsets: Array<{ dx: number; dy: number }>;
  stage?: string;
}

const choiceOptions: Array<{ value: string; label: string }> = [
  { value: "detected", label: "Use detected" },
  { value: "blank", label: "Blank" },
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
  { value: "D", label: "D" }
];

const makeFileId = (file: File, nonce: number) =>
  `${file.name}-${file.size}-${file.lastModified}-${nonce}`;

const studentIdText = (result: OMRResultJson) =>
  result.student.studentId.detected
    .map((digit) => (digit === "" ? "_" : String(digit)))
    .join("");

const statusLabel = (status: QueueStatus) =>
  status === "done"
    ? "Scored"
    : status === "processing"
      ? "Processing"
      : status === "queued"
        ? "Queued"
        : "Needs retake";

const scanErrorMessage = (value: unknown) => {
  const message = value instanceof Error ? value.message : "Unable to grade photo.";
  return message
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+\(Error: [\s\S]*$/, "");
};

const releaseImagingSteps = (steps: ImagingProcessStep[]) => {
  for (const step of steps) {
    if (step.imageUrl.startsWith("blob:")) {
      URL.revokeObjectURL(step.imageUrl);
    }
  }
};

export function ExamGraderDashboard() {
  const templateRef = useRef<OMRTemplate>(
    JSON.parse(JSON.stringify(defaultSheetTemplate)) as OMRTemplate
  );
  const queueRef = useRef<GraderQueueItem[]>([]);
  const runBatchRef = useRef<(() => Promise<void>) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imagingRequestRef = useRef(0);
  const imagingStepsRef = useRef<ImagingProcessStep[]>([]);

  const [selectedExamId, setSelectedExamId] = useState("");
  const [templateReady, setTemplateReady] = useState(false);
  const [queue, setQueue] = useState<GraderQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoProcessTick, setAutoProcessTick] = useState(0);
  const [review, setReview] = useState<ReviewState>({
    fileId: null,
    loading: false,
    error: null,
    overlayUrl: null
  });
  const [imaging, setImaging] = useState<ImagingState>({
    fileId: null,
    loading: false,
    error: null,
    steps: [],
    columnAlignmentOffsets: []
  });

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    imagingStepsRef.current = imaging.steps;
  }, [imaging.steps]);

  useEffect(
    () => () => {
      releaseImagingSteps(imagingStepsRef.current);
    },
    []
  );

  useEffect(() => {
    void warmupOmrWorker().catch(() => {
      // The first scan will surface a detailed initialization error if warmup fails.
    });
    let disposed = false;
    void loadBundledCornerSnapshots().then((snapshots) => {
      if (disposed) return;
      if (!snapshots.tl || !snapshots.tr || !snapshots.br || !snapshots.bl) {
        setError("Corner references could not be loaded. Refresh before grading photos.");
        return;
      }
      templateRef.current = {
        ...templateRef.current,
        cornerSnapshots: {
          ...(templateRef.current.cornerSnapshots ?? {}),
          ...snapshots
        }
      };
      setTemplateReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const updateQueueItem = (
    id: string,
    updater: (item: GraderQueueItem) => GraderQueueItem
  ) => {
    setQueue((current) => {
      const next = current.map((item) => (item.id === id ? updater(item) : item));
      queueRef.current = next;
      return next;
    });
  };

  const addFiles = (files: File[]) => {
    if (!selectedExamId) {
      setError("Choose an exam before uploading answer-sheet photos.");
      return;
    }
    const imageFiles = files.filter((file) => /image\/(png|jpeg|webp)/.test(file.type));
    if (imageFiles.length === 0) {
      setError("Choose PNG, JPG, or WEBP answer-sheet photos.");
      return;
    }
    setError(null);
    setQueue((current) => {
      const existing = new Set(
        current.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`)
      );
      const seed = Date.now();
      const additions = imageFiles
        .filter(
          (file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`)
        )
        .map((file, index) => ({
          id: makeFileId(file, seed + index),
          file,
          examId: selectedExamId,
          status: "queued" as const,
          result: null,
          overrides: {}
        }));
      const next = [...current, ...additions];
      queueRef.current = next;
      if (additions.length > 0) {
        setAutoProcessTick((value) => value + 1);
      }
      return next;
    });
  };

  const processItem = async (
    item: GraderQueueItem,
    index: number,
    total: number,
    signal: AbortSignal
  ) => {
    updateQueueItem(item.id, (current) => ({
      ...current,
      status: "processing",
      detail: "Preparing high-resolution photo..."
    }));
    try {
      const prepared = await prepareImageForScan(item.file, { maxDimension: 2200 });
      const workerBuffer = prepared.rgbaBuffer.slice(0);
      const result = await processSheetFileInWorker(
        workerBuffer,
        prepared.width,
        prepared.height,
        templateRef.current,
        (stage) => {
          setProgress(`Photo ${index + 1}/${total}: ${item.file.name} — ${stage}`);
          updateQueueItem(item.id, (current) => ({ ...current, detail: stage }));
        },
        signal,
        { mode: "grading-v2" }
      );
      updateQueueItem(item.id, (current) => ({
        ...current,
        status: "done",
        result,
        detail: "Score ready"
      }));
    } catch (scanError) {
      updateQueueItem(item.id, (current) => ({
        ...current,
        status: "error",
        result: null,
        detail: scanErrorMessage(scanError)
      }));
    }
  };

  const runBatch = async () => {
    if (!templateReady || loading) return;
    const pending = queueRef.current.filter((item) => item.status === "queued");
    if (pending.length === 0) return;
    const controller = new AbortController();
    setAbortController(controller);
    setLoading(true);
    setError(null);
    try {
      for (let index = 0; index < pending.length; index += 1) {
        if (controller.signal.aborted) break;
        await processItem(pending[index], index, pending.length, controller.signal);
      }
    } finally {
      setLoading(false);
      setAbortController(null);
      setProgress(null);
    }
  };
  runBatchRef.current = runBatch;

  useEffect(() => {
    if (!templateReady || loading) return;
    if (queueRef.current.some((item) => item.status === "queued")) {
      void runBatchRef.current?.();
    }
  }, [autoProcessTick, loading, templateReady]);

  const cancelBatch = () => {
    abortController?.abort();
    setQueue((current) => {
      const next = current.map((item) =>
        item.status === "queued"
          ? { ...item, status: "error" as const, detail: "Batch cancelled." }
          : item
      );
      queueRef.current = next;
      return next;
    });
  };

  const clearBatch = () => {
    abortController?.abort();
    imagingRequestRef.current += 1;
    releaseImagingSteps(imaging.steps);
    setQueue([]);
    queueRef.current = [];
    setProgress(null);
    setError(null);
    setReview({ fileId: null, loading: false, error: null, overlayUrl: null });
    setImaging({
      fileId: null,
      loading: false,
      error: null,
      steps: [],
      columnAlignmentOffsets: []
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const deleteItem = (id: string) => {
    if (queueRef.current.find((item) => item.id === id)?.status === "processing") {
      abortController?.abort();
    }
    setQueue((current) => {
      const next = current.filter((item) => item.id !== id);
      queueRef.current = next;
      return next;
    });
    if (review.fileId === id) {
      setReview({ fileId: null, loading: false, error: null, overlayUrl: null });
    }
    if (imaging.fileId === id) {
      imagingRequestRef.current += 1;
      releaseImagingSteps(imaging.steps);
      setImaging({
        fileId: null,
        loading: false,
        error: null,
        steps: [],
        columnAlignmentOffsets: []
      });
    }
  };

  const retryItem = (id: string) => {
    updateQueueItem(id, (item) => ({
      ...item,
      status: "queued",
      result: null,
      detail: "Queued for another attempt"
    }));
    setAutoProcessTick((value) => value + 1);
  };

  const gradesById = useMemo(() => {
    const grades = new Map<string, SheetGrade>();
    for (const item of queue) {
      const exam = getExamById(item.examId);
      if (exam && item.result) {
        grades.set(item.id, gradeSheet(item.result, exam, item.overrides));
      }
    }
    return grades;
  }, [queue]);

  const openReview = async (fileId: string) => {
    const item = queueRef.current.find((entry) => entry.id === fileId);
    if (!item?.result) return;
    setReview({ fileId, loading: true, error: null, overlayUrl: null });
    try {
      const steps = await buildVisualParsingSteps(item.file, templateRef.current);
      const regions = steps.find((step) => step.id === "regions");
      setReview({
        fileId,
        loading: false,
        error: null,
        overlayUrl: regions?.imageDataUrl ?? null
      });
    } catch (reviewError) {
      setReview({
        fileId,
        loading: false,
        error:
          reviewError instanceof Error
            ? reviewError.message
            : "Unable to build transformed preview.",
        overlayUrl: null
      });
    }
  };

  const openImagingProcess = async (fileId: string) => {
    const item = queueRef.current.find((entry) => entry.id === fileId);
    if (!item) return;
    releaseImagingSteps(imaging.steps);
    const requestId = imagingRequestRef.current + 1;
    imagingRequestRef.current = requestId;
    setImaging({
      fileId,
      loading: true,
      error: null,
      steps: [],
      columnAlignmentOffsets: []
    });
    try {
      const prepared = await prepareImageForScan(item.file, { maxDimension: 2200 });
      const visualization = await buildGradingVisualizationInWorker(
        prepared.rgbaBuffer.slice(0),
        prepared.width,
        prepared.height,
        templateRef.current,
        (stage) =>
          setImaging((current) =>
            current.fileId === fileId ? { ...current, stage } : current
          )
      );
      const steps: ImagingProcessStep[] = visualization.steps.map((step) => ({
        id: step.id,
        title: step.title,
        description: step.description,
        imageUrl: URL.createObjectURL(item.file)
      }));
      if (imagingRequestRef.current !== requestId) {
        releaseImagingSteps(steps);
        return;
      }
      setImaging({
        fileId,
        loading: false,
        error: null,
        steps,
        blockingReason: visualization.blockingReason,
        paperDetection: visualization.paperDetection,
        columnAlignmentOffsets: visualization.columnAlignmentOffsets
      });
    } catch (visualizationError) {
      if (imagingRequestRef.current !== requestId) return;
      setImaging({
        fileId,
        loading: false,
        error: scanErrorMessage(visualizationError),
        steps: [],
        columnAlignmentOffsets: []
      });
    }
  };

  const closeImagingProcess = () => {
    imagingRequestRef.current += 1;
    releaseImagingSteps(imaging.steps);
    setImaging({
      fileId: null,
      loading: false,
      error: null,
      steps: [],
      columnAlignmentOffsets: []
    });
  };

  const applyImagingAnswerOverride = (question: number, choice: ChoiceLabel) => {
    if (!imaging.fileId) return;
    updateQueueItem(imaging.fileId, (item) => {
      const answer = item.result?.answers.find((entry) => entry.q === question);
      if (!answer) return item;
      return {
        ...item,
        overrides: applyAnswerBubbleClick(answer, item.overrides, choice)
      };
    });
  };

  const resetImagingOverrides = () => {
    if (!imaging.fileId) return;
    updateQueueItem(imaging.fileId, (item) => ({
      ...item,
      overrides: resetAnswerOverrides()
    }));
  };

  const setAnswerOverride = (fileId: string, question: number, value: string) => {
    updateQueueItem(fileId, (item) => {
      const overrides = { ...item.overrides };
      if (value === "detected") {
        delete overrides[question];
      } else {
        overrides[question] = value === "blank" ? null : (value as ChoiceLabel);
      }
      return { ...item, overrides };
    });
  };

  const reviewItem = review.fileId
    ? queue.find((item) => item.id === review.fileId) ?? null
    : null;
  const reviewGrade = review.fileId ? gradesById.get(review.fileId) ?? null : null;
  const imagingItem = imaging.fileId
    ? queue.find((item) => item.id === imaging.fileId) ?? null
    : null;

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <AppDashboardShell appTitle="AERC Exam Grader">
      <header className="dashboard-header grader-header">
        <div>
          <h1 className="dashboard-title">Photo Exam Grader</h1>
          <p className="subtle-text">
            Choose an exam, upload phone photos, and review the calculated score.
          </p>
        </div>
        <span className={`grader-ready-badge${templateReady ? " is-ready" : ""}`}>
          {templateReady ? "OpenCV ready" : "Loading OpenCV template…"}
        </span>
      </header>

      <section className="grader-setup-grid">
        <article className="grader-panel">
          <span className="grader-step">Step 1</span>
          <label htmlFor="grader-exam-select">
            Exam
            <select
              id="grader-exam-select"
              value={selectedExamId}
              disabled={queue.length > 0}
              onChange={(event) => {
                setSelectedExamId(event.target.value);
                setError(null);
              }}
            >
              <option value="">Choose an exam…</option>
              {examCatalog.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.name}
                </option>
              ))}
            </select>
          </label>
          {queue.length > 0 ? (
            <p className="subtle-text">
              Clear the batch to select a different exam.
            </p>
          ) : null}
        </article>

        <article className="grader-panel grader-guidance">
          <span className="grader-step">Photo checklist</span>
          <ul>
            <li>Keep the sheet flat and include all four black corner squares.</li>
            <li>Hold the camera parallel to the page and avoid glare or hands.</li>
            <li>Use even lighting; broad shadows are corrected when detail remains visible.</li>
          </ul>
        </article>
      </section>

      <section
        className={`upload-dropzone grader-dropzone${
          dragActive ? " upload-dropzone-active" : ""
        }${!selectedExamId ? " grader-dropzone-disabled" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (selectedExamId) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <span className="grader-step">Step 2</span>
        <h3>Drop answer-sheet photos here</h3>
        <p>Batch upload PNG, JPG, or WEBP files. Processing starts automatically.</p>
        <input
          id="grader-file-input"
          ref={fileInputRef}
          className="drop-area-input"
          type="file"
          multiple
          disabled={!selectedExamId}
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <label
          htmlFor="grader-file-input"
          className={`drop-action${!selectedExamId ? " is-disabled" : ""}`}
        >
          Browse Photos
        </label>
      </section>

      <section className="queue-section grader-results">
        <header>
          <div className="queue-header-left">
            <h3>Batch Results ({queue.length})</h3>
            {progress ? <span className="subtle-text">{progress}</span> : null}
          </div>
          <div className="queue-header-actions">
            {loading ? <button onClick={cancelBatch}>Cancel</button> : null}
            <button
              className="destructive-filled"
              onClick={clearBatch}
              disabled={queue.length === 0}
            >
              Clear Batch
            </button>
          </div>
        </header>
        {error ? <p className="error grader-error">{error}</p> : null}
        {queue.length === 0 ? (
          <div className="grader-empty-state">
            <strong>No answer sheets yet</strong>
            <span>Select an exam and add one or more photos.</span>
          </div>
        ) : (
          <div className="grader-result-list">
            {queue.map((item) => {
              const grade = gradesById.get(item.id);
              const quality = item.result?.pipeline.quality;
              return (
                <article className="grader-result-card" key={item.id}>
                  <div className="grader-result-main">
                    <div className="grader-result-title">
                      <div>
                        <strong>{item.file.name}</strong>
                        <p>
                          {getExamById(item.examId)?.name ?? item.examId}
                          {item.result ? ` · Student ${studentIdText(item.result)}` : ""}
                        </p>
                      </div>
                      <span className={`processing-badge processing-${item.status}`}>
                        {statusLabel(item.status)}
                      </span>
                    </div>
                    {item.detail ? <p className="grader-result-detail">{item.detail}</p> : null}
                    {grade ? (
                      <>
                        <div className="grader-score-row">
                          <div className="grader-score">
                            <strong>{grade.score}</strong>
                            <span>/ {grade.total}</span>
                          </div>
                          <div className="grader-percentage">{grade.percentage}%</div>
                          <div className="grader-stat is-correct">
                            <strong>{grade.correctCount}</strong>
                            <span>Correct</span>
                          </div>
                          <div className="grader-stat is-wrong">
                            <strong>{grade.wrongCount}</strong>
                            <span>Wrong</span>
                          </div>
                          <div className="grader-stat is-blank">
                            <strong>{grade.blankCount}</strong>
                            <span>Blank</span>
                          </div>
                          <div className="grader-stat is-ambiguous">
                            <strong>{grade.ambiguousCount}</strong>
                            <span>Ambiguous</span>
                          </div>
                        </div>
                        {quality ? (
                          <div className="grader-quality-row">
                            <span>
                              Corners {quality.markersDetected}/4
                            </span>
                            <span>
                              Perspective {quality.warpSucceeded ? "corrected" : "failed"}
                            </span>
                            <span>
                              Paper{" "}
                              {quality.paperDetection.detected
                                ? `${Math.round(
                                    quality.paperDetection.confidence * 100
                                  )}%`
                                : "fallback"}
                            </span>
                            <span>Sharpness {Math.round(quality.sharpnessScore)}</span>
                            <span>Contrast {Math.round(quality.localContrast)}</span>
                            <span>
                              Highlight clipping{" "}
                              {Math.round(quality.clippedLightRatio * 100)}%
                            </span>
                            <span>
                              Column confidence{" "}
                              {quality.columnAlignmentConfidence
                                .map((value) => `${Math.round(value * 100)}%`)
                                .join(" · ")}
                            </span>
                            {quality.warnings.map((warning) => (
                              <span className="is-warning" key={warning}>
                                {warning}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <div className="grader-result-actions">
                    {item.status === "done" || item.status === "error" ? (
                      <button
                        disabled={loading}
                        onClick={() => void openImagingProcess(item.id)}
                      >
                        View Imaging Process
                      </button>
                    ) : null}
                    {item.status === "done" ? (
                      <button onClick={() => void openReview(item.id)}>Review Score</button>
                    ) : null}
                    {item.status === "error" ? (
                      <button onClick={() => retryItem(item.id)}>Retry</button>
                    ) : null}
                    <button
                      className="queue-icon-button queue-icon-button-destructive"
                      onClick={() => deleteItem(item.id)}
                      title="Delete photo"
                      aria-label={`Delete ${item.file.name}`}
                    >
                      🗑
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {reviewItem && reviewGrade ? (
        <div
          className="override-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setReview({ fileId: null, loading: false, error: null, overlayUrl: null });
            }
          }}
        >
          <section className="grader-review-dialog" role="dialog" aria-modal="true">
            <header className="modal-header">
              <div>
                <h2>Review Score — {reviewItem.file.name}</h2>
                <p>
                  {reviewGrade.score}/{reviewGrade.total} ({reviewGrade.percentage}%)
                </p>
              </div>
              <button
                onClick={() =>
                  setReview({
                    fileId: null,
                    loading: false,
                    error: null,
                    overlayUrl: null
                  })
                }
              >
                Close
              </button>
            </header>
            {review.loading ? (
              <p className="subtle-text">Building transformed ROI preview…</p>
            ) : null}
            {review.error ? <p className="error">{review.error}</p> : null}
            <div className="grader-review-grid">
              <div className="grader-review-preview">
                {review.overlayUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={review.overlayUrl} alt="Transformed answer-sheet ROI overlay" />
                ) : (
                  <p className="subtle-text">Preview is unavailable.</p>
                )}
              </div>
              <div className="grader-answer-review">
                <div className="grader-answer-review-header">
                  <strong>Question review</strong>
                  <span>Override uncertain or incorrect detections.</span>
                </div>
                <div className="grader-answer-table" role="table">
                  <div className="grader-answer-row grader-answer-row-header" role="row">
                    <span>Q</span>
                    <span>Detected</span>
                    <span>Key</span>
                    <span>Confidence</span>
                    <span>Status</span>
                    <span>Override</span>
                  </div>
                  {reviewGrade.answers.map((answerGrade) => {
                    const hasOverride = Object.prototype.hasOwnProperty.call(
                      reviewItem.overrides,
                      answerGrade.question
                    );
                    const overrideValue = hasOverride
                      ? reviewItem.overrides[answerGrade.question] ?? "blank"
                      : "detected";
                    return (
                      <div
                        className={`grader-answer-row status-${answerGrade.status}`}
                        role="row"
                        key={answerGrade.question}
                      >
                        <strong>{answerGrade.question}</strong>
                        <span>
                          {answerGrade.detected.length > 0
                            ? answerGrade.detected.join(",")
                            : answerGrade.status === "ambiguous"
                              ? "Ambiguous"
                              : "Blank"}
                        </span>
                        <strong>{answerGrade.expected}</strong>
                        <span>{Math.round(answerGrade.confidence * 100)}%</span>
                        <span>{answerGrade.status}</span>
                        <select
                          aria-label={`Override question ${answerGrade.question}`}
                          value={overrideValue}
                          onChange={(event) =>
                            setAnswerOverride(
                              reviewItem.id,
                              answerGrade.question,
                              event.target.value
                            )
                          }
                        >
                          {choiceOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {imaging.fileId ? (
        <ImagingProcessDialog
          fileName={imagingItem?.file.name ?? "Answer sheet"}
          steps={imaging.steps}
          loading={imaging.loading}
          loadingStage={imaging.stage}
          error={imaging.error}
          blockingReason={imaging.blockingReason}
          result={imagingItem?.result ?? null}
          overrides={imagingItem?.overrides ?? {}}
          template={templateRef.current}
          paperDetection={imaging.paperDetection}
          columnAlignmentOffsets={imaging.columnAlignmentOffsets}
          onAnswerClick={applyImagingAnswerOverride}
          onResetOverrides={resetImagingOverrides}
          onClose={closeImagingProcess}
        />
      ) : null}
    </AppDashboardShell>
  );
}
