"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VisualParsingDialog } from "@/components/VisualParsingDialog";
import {
  buildRoiReadAreaStepsFromRectifiedDataUrl,
  buildVisualParsingSteps,
  type CornerWindowVisual,
  type VisualParseStep
} from "@/lib/omr/buildVisualParsingSteps";
import { applyRoiBoxesToTemplate, type RoiBoxVisual } from "@/lib/omr/roiCalibration";
import { processSheetFileInWorker, warmupOmrWorker } from "@/lib/omr/processSheetInWorker";
import { prepareImageForScan } from "@/lib/omr/prepareImageForScan";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import { loadBundledCornerSnapshots } from "@/lib/templates/loadBundledCornerSnapshots";
import type { ChoiceLabel, CornerSnapshot, OMRResultJson, OMRTemplate } from "@/types/omr";

type QueueStatus = "queued" | "processing" | "done" | "error";

interface QueueFileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: QueueStatus;
  result: OMRResultJson | null;
  detail?: string;
  diagnostics?: string;
  thresholdUsed?: number;
}

interface TransformReviewState {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  fileId: string | null;
  fileName: string;
  overlayUrl: string | null;
  summaryLines: string[];
}

type IssueKey =
  | "warn-triangulated-corners"
  | "warn-uneven-corners"
  | "warn-many-multi-dominant-answers"
  | "error-id-incomplete"
  | "error-no-exam-set";

interface IssueDefinition {
  key: IssueKey;
  label: string;
  kind: "warning" | "error";
}

const issueDefinitions: IssueDefinition[] = [
  {
    key: "warn-triangulated-corners",
    label: "Uneven Corners Detected (Triangulation used)",
    kind: "warning"
  },
  {
    key: "warn-uneven-corners",
    label: "Uneven corners detected (manual corner adjustment needed)",
    kind: "warning"
  },
  {
    key: "warn-many-multi-dominant-answers",
    label: "25% answers have 2+ dominant letters",
    kind: "warning"
  },
  {
    key: "error-id-incomplete",
    label: "ID number incomplete",
    kind: "error"
  },
  {
    key: "error-no-exam-set",
    label: "No Exam Set",
    kind: "error"
  }
];

const countDominantLetters = (
  shadeScores: OMRResultJson["answers"][number]["shadeScores"],
  threshold: number,
  ambiguityGap = 0.03
) => {
  const sorted = Object.values(shadeScores).sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  return Object.values(shadeScores).filter(
    (score) => score >= threshold && top - score <= ambiguityGap
  ).length;
};

const getItemIssues = (item: QueueFileItem): IssueKey[] => {
  if (!item.result) {
    return [];
  }
  const issues: IssueKey[] = [];
  const pipeline = item.result.pipeline;
  if ((pipeline.cornerFoundCount ?? 4) < 4 || (pipeline.cornerTriangulatedCount ?? 0) > 0) {
    issues.push("warn-triangulated-corners");
  }
  if (pipeline.cornerUneven && (pipeline.cornerTriangulatedCount ?? 0) === 0) {
    issues.push("warn-uneven-corners");
  }

  const threshold = item.thresholdUsed ?? 0.28;
  const multiDominantAnswers = item.result.answers.filter(
    (answer) => countDominantLetters(answer.shadeScores, threshold) >= 2
  ).length;
  if (
    item.result.answers.length > 0 &&
    multiDominantAnswers >= Math.ceil(item.result.answers.length * 0.25)
  ) {
    issues.push("warn-many-multi-dominant-answers");
  }

  if (item.result.student.studentId.detected.some((digit) => digit === "")) {
    issues.push("error-id-incomplete");
  }
  if ((item.result.student.examSet.selected?.length ?? 0) === 0) {
    issues.push("error-no-exam-set");
  }

  return issues;
};

const makeFileId = (file: File, nonce: number) =>
  `${file.name}-${file.size}-${file.lastModified}-${nonce}`;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const excelHeaders = [
  "file_name",
  ...Array.from({ length: 6 }, (_, index) => `Student ID Number-${index}`),
  ...Array.from({ length: 3 }, (_, index) => `Exam Code-${index}`),
  "Exam Set-0",
  ...Array.from({ length: 35 }, (_, index) => `Answer Sheet 1-${index}`),
  ...Array.from({ length: 35 }, (_, index) => `Answer Sheet 2-${index}`),
  ...Array.from({ length: 30 }, (_, index) => `Answer Sheet 3-${index}`)
] as const;

const clampThreshold = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.28;
const clampCornerAngleTolerance = (value: number) =>
  Number.isFinite(value) ? Math.min(30, Math.max(0.5, value)) : 4.5;

const columnIndexToExcelLetter = (columnIndex: number): string => {
  let value = Math.max(1, Math.floor(columnIndex));
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
};

const buildTransformSummary = (result: OMRResultJson, threshold: number): string[] => {
  const multiDominantAnswers = result.answers.filter(
    (answer) => countDominantLetters(answer.shadeScores, threshold) >= 2
  ).length;
  const blankAnswers = result.answers.filter((answer) => (answer.selected?.length ?? 0) === 0).length;
  const ambiguousAnswers = result.answers.filter((answer) => answer.ambiguous).length;
  const studentIdText = result.student.studentId.detected
    .map((digit) => (digit === "" ? "_" : String(digit)))
    .join("");
  const examCodeText = result.student.examCode.detected
    .map((digit) => (digit === "" ? "_" : String(digit)))
    .join("");
  const examSetText = result.student.examSet.selected.join(",") || "(blank)";
  return [
    `Student ID: ${studentIdText}`,
    `Exam Code: ${examCodeText}`,
    `Exam Set: ${examSetText}`,
    `Threshold Used: ${threshold.toFixed(2)}`,
    `Answers with 2+ dominant letters: ${multiDominantAnswers}/${result.answers.length}`,
    `Blank answers: ${blankAnswers}`,
    `Ambiguous answers: ${ambiguousAnswers}`,
    `Corners detected: ${result.pipeline.cornerFoundCount ?? 0}/4`,
    `Corners used: ${result.pipeline.cornerUsedCount ?? 0}/4`,
    `Corners triangulated: ${result.pipeline.cornerTriangulatedCount ?? 0}`
  ];
};

export function MainScannerDashboard() {
  const [activeTemplate, setActiveTemplate] = useState<OMRTemplate>(() =>
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const [scanTemplateReady, setScanTemplateReady] = useState(false);
  const activeTemplateRef = useRef<OMRTemplate>(
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const referenceTemplateRef = useRef<OMRTemplate>(
    JSON.parse(JSON.stringify(defaultSheetTemplate))
  );
  const fileTemplateOverridesRef = useRef<
    Record<string, Partial<Pick<OMRTemplate, "cornerSnapshots" | "cornerSearchWindows">>>
  >({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<QueueFileItem[]>([]);

  const [queue, setQueue] = useState<QueueFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanStage, setScanStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [overrideFileId, setOverrideFileId] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState("");
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [visualDialogOpen, setVisualDialogOpen] = useState(false);
  const [visualDialogLoading, setVisualDialogLoading] = useState(false);
  const [visualDialogStage, setVisualDialogStage] = useState<string | null>(null);
  const [visualDialogError, setVisualDialogError] = useState<string | null>(null);
  const [visualSteps, setVisualSteps] = useState<VisualParseStep[]>([]);
  const [activeVisualFileId, setActiveVisualFileId] = useState<string | null>(null);
  const [autoProcessTick, setAutoProcessTick] = useState(0);
  const runBatchProcessRef = useRef<(() => Promise<void>) | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [selectedIssueFilters, setSelectedIssueFilters] = useState<IssueKey[]>([]);
  const [darknessThreshold, setDarknessThreshold] = useState<number>(
    defaultSheetTemplate.scoring?.darknessThreshold ?? 0.28
  );
  const [cornerAngleToleranceDegrees, setCornerAngleToleranceDegrees] = useState<number>(
    defaultSheetTemplate.scoring?.cornerAngleToleranceDegrees ?? 4.5
  );
  const [transformReview, setTransformReview] = useState<TransformReviewState>({
    isOpen: false,
    loading: false,
    error: null,
    fileId: null,
    fileName: "",
    overlayUrl: null,
    summaryLines: []
  });

  useEffect(() => {
    activeTemplateRef.current = activeTemplate;
  }, [activeTemplate]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const issueMapByFileId = useMemo(
    () =>
      new Map<string, IssueKey[]>(
        queue.map((item) => [item.id, getItemIssues(item)])
      ),
    [queue]
  );
  const issueCounts = useMemo(() => {
    const counts: Record<IssueKey, number> = {
      "warn-triangulated-corners": 0,
      "warn-uneven-corners": 0,
      "warn-many-multi-dominant-answers": 0,
      "error-id-incomplete": 0,
      "error-no-exam-set": 0
    };
    for (const issues of issueMapByFileId.values()) {
      for (const issue of issues) {
        counts[issue] += 1;
      }
    }
    return counts;
  }, [issueMapByFileId]);
  const activeIssueDefinitions = useMemo(
    () => issueDefinitions.filter((definition) => issueCounts[definition.key] > 0),
    [issueCounts]
  );
  const filteredQueue = useMemo(() => {
    if (selectedIssueFilters.length === 0) {
      return queue;
    }
    return queue.filter((item) => {
      const issues = issueMapByFileId.get(item.id) ?? [];
      return selectedIssueFilters.some((key) => issues.includes(key));
    });
  }, [queue, issueMapByFileId, selectedIssueFilters]);

  useEffect(() => {
    setSelectedIssueFilters((current) =>
      current.filter((key) => issueCounts[key] > 0)
    );
  }, [issueCounts]);

  useEffect(() => {
    void warmupOmrWorker().catch(() => {
      // Warmup is best-effort.
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(max-width: 960px)");
    const onChange = () => {
      const mobile = media.matches;
      setIsMobileViewport(mobile);
      if (!mobile) {
        setIsMobileDrawerOpen(false);
      }
    };
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadBundledCornerSnapshots().then((snapshots) => {
      if (disposed) {
        return;
      }
      if (!snapshots.tl || !snapshots.tr || !snapshots.br || !snapshots.bl) {
        return;
      }
      const nextReferenceTemplate: OMRTemplate = {
        ...referenceTemplateRef.current,
        cornerSnapshots: {
          ...(referenceTemplateRef.current.cornerSnapshots ?? {}),
          ...snapshots
        }
      };
      referenceTemplateRef.current = nextReferenceTemplate;
      // Visual dialog starts from bundled references, while scan uses
      // this reference template regardless of later draggable edits.
      setActiveTemplate(nextReferenceTemplate);
      setScanTemplateReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const updateQueueItem = (id: string, updater: (item: QueueFileItem) => QueueFileItem) => {
    setQueue((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  };

  const buildProcessingTemplateForFile = (fileId: string): OMRTemplate => {
    const fileOverride = fileTemplateOverridesRef.current[fileId];
    if (!fileOverride) {
      return referenceTemplateRef.current;
    }
    return {
      ...referenceTemplateRef.current,
      cornerSnapshots: {
        ...(referenceTemplateRef.current.cornerSnapshots ?? {}),
        ...(fileOverride.cornerSnapshots ?? {})
      },
      cornerSearchWindows: {
        ...(referenceTemplateRef.current.cornerSearchWindows ?? {}),
        ...(fileOverride.cornerSearchWindows ?? {})
      }
    };
  };

  const addFilesToQueue = (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setQueue((current) => {
      const existing = new Set(
        current.map((item) => `${item.name}:${item.size}:${item.file.lastModified}`)
      );
      const seed = Date.now();
      const newItems = files
        .filter((file) => /image\/(png|jpeg|webp)/.test(file.type))
        .filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`))
        .map((file, index) => ({
          id: makeFileId(file, seed + index),
          file,
          name: file.name,
          size: file.size,
          status: "queued" as const,
          result: null as OMRResultJson | null
        }));
      if (newItems.length > 0) {
        setAutoProcessTick((value) => value + 1);
      }
      const nextQueue = [...current, ...newItems];
      queueRef.current = nextQueue;
      return nextQueue;
    });
  };

  const processOneFile = async (
    item: QueueFileItem,
    index: number,
    total: number,
    signal: AbortSignal
  ) => {
    updateQueueItem(item.id, (current) => ({
      ...current,
      status: "processing",
      detail: "Preparing image..."
    }));
    try {
      const prepared = await prepareImageForScan(item.file);
      const workerBuffer = prepared.rgbaBuffer.slice(0);
      const processingTemplate = buildProcessingTemplateForFile(item.id);
      const thresholdUsed = processingTemplate.scoring?.darknessThreshold ?? 0.28;
      const scanned = await processSheetFileInWorker(
        workerBuffer,
        prepared.width,
        prepared.height,
        processingTemplate,
        (stage) => {
          setScanStage(`Processing ${index + 1}/${total}: ${item.name} — ${stage}`);
          updateQueueItem(item.id, (current) => ({ ...current, detail: stage }));
        },
        signal
      );
      updateQueueItem(item.id, (current) => ({
        ...current,
        status: "done",
        result: scanned,
        detail: "Scan complete",
        thresholdUsed,
        diagnostics: `Corners found ${scanned.pipeline.cornerFoundCount ?? 0}/4, used ${
          scanned.pipeline.cornerUsedCount ?? 0
        }/4, triangulated ${scanned.pipeline.cornerTriangulatedCount ?? 0}, warped ${
          scanned.pipeline.warped ? "yes" : "no"
        }`
      }));
    } catch (scanError) {
      updateQueueItem(item.id, (current) => ({
        ...current,
        status: "error",
        detail: scanError instanceof Error ? scanError.message : "Scan failed."
      }));
    }
  };

  const runBatchProcess = async () => {
    if (!scanTemplateReady) {
      setError("Corner reference snapshots are still loading. Please retry in a moment.");
      return;
    }
    const pending = queueRef.current.filter((item) => item.status === "queued" || item.status === "error");
    if (pending.length === 0) {
      setError("Add at least one file to start batch processing.");
      return;
    }
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    setAbortController(controller);
    try {
      for (let index = 0; index < pending.length; index += 1) {
        if (controller.signal.aborted) {
          break;
        }
        await processOneFile(pending[index], index, pending.length, controller.signal);
      }
    } finally {
      setLoading(false);
      setAbortController(null);
      setScanStage(null);
    }
  };
  runBatchProcessRef.current = runBatchProcess;

  useEffect(() => {
    if (!scanTemplateReady || loading) {
      return;
    }
    if (queueRef.current.some((item) => item.status === "queued")) {
      void runBatchProcessRef.current?.();
    }
  }, [autoProcessTick, loading, scanTemplateReady]);

  const cancelBatch = () => {
    abortController?.abort();
  };

  const deleteFromQueue = (id: string) => {
    const target = queueRef.current.find((item) => item.id === id);
    if (target?.status === "processing") {
      abortController?.abort();
    }
    setQueue((current) => {
      const nextQueue = current.filter((item) => item.id !== id);
      queueRef.current = nextQueue;
      return nextQueue;
    });
    delete fileTemplateOverridesRef.current[id];
    if (overrideFileId === id) {
      setOverrideFileId(null);
      setOverrideDraft("");
      setOverrideError(null);
    }
    if (transformReview.fileId === id) {
      setTransformReview({
        isOpen: false,
        loading: false,
        error: null,
        fileId: null,
        fileName: "",
        overlayUrl: null,
        summaryLines: []
      });
    }
  };

  const deleteAllFiles = () => {
    abortController?.abort();
    setQueue([]);
    queueRef.current = [];
    fileTemplateOverridesRef.current = {};
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setSelectedIssueFilters([]);
    setScanStage(null);
    setError(null);
    if (overrideFileId) {
      setOverrideFileId(null);
      setOverrideDraft("");
      setOverrideError(null);
    }
    if (transformReview.isOpen) {
      setTransformReview({
        isOpen: false,
        loading: false,
        error: null,
        fileId: null,
        fileName: "",
        overlayUrl: null,
        summaryLines: []
      });
    }
  };

  const toggleIssueFilter = (key: IssueKey) => {
    setSelectedIssueFilters((current) =>
      current.includes(key)
        ? current.filter((value) => value !== key)
        : [...current, key]
    );
  };

  const openOverrideDialog = (id: string) => {
    const item = queueRef.current.find((entry) => entry.id === id);
    if (!item?.result) {
      setError("This file does not have a scan result yet.");
      return;
    }
    setOverrideFileId(id);
    setOverrideDraft(JSON.stringify(item.result, null, 2));
    setOverrideError(null);
  };

  const applyOverride = () => {
    if (!overrideFileId) {
      return;
    }
    try {
      const parsed = JSON.parse(overrideDraft) as OMRResultJson;
      updateQueueItem(overrideFileId, (item) => ({
        ...item,
        result: parsed,
        status: "done",
        detail: "Result overridden manually"
      }));
      setOverrideFileId(null);
      setOverrideDraft("");
      setOverrideError(null);
    } catch (parseError) {
      setOverrideError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
    }
  };

  const overrideItem = useMemo(
    () => queue.find((item) => item.id === overrideFileId) ?? null,
    [queue, overrideFileId]
  );
  const activeVisualFile = useMemo(
    () => queue.find((item) => item.id === activeVisualFileId) ?? null,
    [queue, activeVisualFileId]
  );
  const transformReviewItem = useMemo(
    () =>
      transformReview.fileId
        ? queue.find((item) => item.id === transformReview.fileId) ?? null
        : null,
    [queue, transformReview.fileId]
  );
  useEffect(() => {
    const shouldLockBodyScroll =
      visualDialogOpen || Boolean(overrideFileId) || transformReview.isOpen;
    if (!shouldLockBodyScroll || typeof window === "undefined") {
      return;
    }
    const { body } = document;
    const scrollY = window.scrollY;
    const previousOverflow = body.style.overflow;
    const previousPosition = body.style.position;
    const previousTop = body.style.top;
    const previousWidth = body.style.width;

    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";

    return () => {
      body.style.overflow = previousOverflow;
      body.style.position = previousPosition;
      body.style.top = previousTop;
      body.style.width = previousWidth;
      window.scrollTo(0, scrollY);
    };
  }, [visualDialogOpen, overrideFileId, transformReview.isOpen]);
  const answerSelectionByQuestion = useMemo(() => {
    const map = new Map<number, ChoiceLabel[]>();
    for (const answer of transformReviewItem?.result?.answers ?? []) {
      map.set(answer.q, answer.selected ?? []);
    }
    return map;
  }, [transformReviewItem?.result?.answers]);

  const openVisualDialog = async (fileId: string) => {
    const target = queueRef.current.find((item) => item.id === fileId);
    if (!target) {
      setError("File not found for visual parsing.");
      return;
    }
    setActiveVisualFileId(fileId);
    setVisualDialogOpen(true);
    setVisualDialogLoading(true);
    setVisualDialogError(null);
    setVisualDialogStage("Preparing visual parsing steps...");
    try {
      const fileTemplate = buildProcessingTemplateForFile(fileId);
      const steps = await buildVisualParsingSteps(
        target.file,
        fileTemplate,
        (stage) => setVisualDialogStage(stage)
      );
      setVisualSteps(steps);
    } catch (dialogError) {
      setVisualDialogError(
        dialogError instanceof Error
          ? dialogError.message
          : "Unable to generate visual parsing steps."
      );
    } finally {
      setVisualDialogLoading(false);
      setVisualDialogStage(null);
    }
  };

  const openTransformReview = async (fileId: string) => {
    const target = queueRef.current.find((item) => item.id === fileId);
    if (!target || !target.result) {
      setError("File has no parsed result yet.");
      return;
    }
    setTransformReview({
      isOpen: true,
      loading: true,
      error: null,
      fileId,
      fileName: target.name,
      overlayUrl: null,
      summaryLines: []
    });
    try {
      const fileTemplate = buildProcessingTemplateForFile(fileId);
      const steps = await buildVisualParsingSteps(target.file, fileTemplate);
      const roiStep = steps.find((step) => step.id === "regions");
      const threshold = target.thresholdUsed ?? (fileTemplate.scoring?.darknessThreshold ?? 0.28);
      const summaryLines = buildTransformSummary(target.result, threshold);
      setTransformReview((current) => ({
        ...current,
        loading: false,
        overlayUrl: roiStep?.imageDataUrl ?? null,
        summaryLines
      }));
    } catch (reviewError) {
      setTransformReview((current) => ({
        ...current,
        loading: false,
        error: reviewError instanceof Error ? reviewError.message : "Unable to build transformed review."
      }));
    }
  };

  const applyTransformDigitOverride = (group: "studentId" | "examCode", rowIndex: number, nextValue: number | "") => {
    if (!transformReview.fileId) {
      return;
    }
    let nextSummaryLines: string[] | null = null;
    updateQueueItem(transformReview.fileId, (item) => {
      if (!item.result) {
        return item;
      }
      const nextDigits = [...(item.result.student[group].detected ?? [])];
      nextDigits[rowIndex] = nextValue;
      const nextResult: OMRResultJson = {
        ...item.result,
        student: {
          ...item.result.student,
          [group]: {
            ...item.result.student[group],
            detected: nextDigits
          }
        }
      };
      const threshold = item.thresholdUsed ?? (referenceTemplateRef.current.scoring?.darknessThreshold ?? 0.28);
      nextSummaryLines = buildTransformSummary(nextResult, threshold);
      return {
        ...item,
        result: nextResult,
        status: "done",
        detail: "Result overridden from transformed review"
      };
    });
    if (nextSummaryLines) {
      setTransformReview((current) => ({ ...current, summaryLines: nextSummaryLines ?? current.summaryLines }));
    }
  };

  const applyTransformExamSetOverride = (choice: ChoiceLabel) => {
    if (!transformReview.fileId) {
      return;
    }
    let nextSummaryLines: string[] | null = null;
    updateQueueItem(transformReview.fileId, (item) => {
      if (!item.result) {
        return item;
      }
      const isAlreadySelected = item.result.student.examSet.selected.includes(choice);
      const nextSelected = isAlreadySelected ? [] : [choice];
      const nextResult: OMRResultJson = {
        ...item.result,
        student: {
          ...item.result.student,
          examSet: {
            ...item.result.student.examSet,
            selected: nextSelected,
            ambiguous: false,
            confidence: nextSelected.length === 1 ? 1 : 0
          }
        }
      };
      const threshold = item.thresholdUsed ?? (referenceTemplateRef.current.scoring?.darknessThreshold ?? 0.28);
      nextSummaryLines = buildTransformSummary(nextResult, threshold);
      return {
        ...item,
        result: nextResult,
        status: "done",
        detail: "Result overridden from transformed review"
      };
    });
    if (nextSummaryLines) {
      setTransformReview((current) => ({ ...current, summaryLines: nextSummaryLines ?? current.summaryLines }));
    }
  };

  const applyTransformAnswerOverride = (question: number, choice: ChoiceLabel) => {
    if (!transformReview.fileId) {
      return;
    }
    let nextSummaryLines: string[] | null = null;
    updateQueueItem(transformReview.fileId, (item) => {
      if (!item.result) {
        return item;
      }
      const nextAnswers = item.result.answers.map((answer) => {
        if (answer.q !== question) {
          return answer;
        }
        const isActive = answer.selected.includes(choice);
        const nextSelected: ChoiceLabel[] = isActive ? [] : [choice];
        return {
          ...answer,
          selected: nextSelected,
          ambiguous: false,
          confidence: nextSelected.length === 1 ? 1 : 0
        };
      });
      const nextResult: OMRResultJson = {
        ...item.result,
        answers: nextAnswers
      };
      const threshold = item.thresholdUsed ?? (referenceTemplateRef.current.scoring?.darknessThreshold ?? 0.28);
      nextSummaryLines = buildTransformSummary(nextResult, threshold);
      return {
        ...item,
        result: nextResult,
        status: "done",
        detail: "Result overridden from transformed review"
      };
    });
    if (nextSummaryLines) {
      setTransformReview((current) => ({ ...current, summaryLines: nextSummaryLines ?? current.summaryLines }));
    }
  };

  const rebuildVisualStepsForTemplate = async (
    template: OMRTemplate,
    stageMessage: string
  ): Promise<void> => {
    if (!activeVisualFile || !visualDialogOpen) {
      return;
    }
    setVisualDialogLoading(true);
    setVisualDialogError(null);
    setVisualDialogStage(stageMessage);
    try {
      const steps = await buildVisualParsingSteps(activeVisualFile.file, template, (stage) =>
        setVisualDialogStage(stage)
      );
      setVisualSteps(steps);
    } catch (dialogError) {
      setVisualDialogError(
        dialogError instanceof Error
          ? dialogError.message
          : "Unable to refresh visual parsing steps."
      );
    } finally {
      setVisualDialogLoading(false);
      setVisualDialogStage(null);
    }
  };

  const applyCornerWindows = (windows: CornerWindowVisual[]) => {
    const searchWindows = windows.reduce<NonNullable<OMRTemplate["cornerSearchWindows"]>>(
      (accumulator, cornerWindow) => {
        accumulator[cornerWindow.id] = {
          x: cornerWindow.x,
          y: cornerWindow.y,
          w: cornerWindow.w,
          h: cornerWindow.h
        };
        return accumulator;
      },
      {}
    );
    const currentTemplate = activeTemplateRef.current;
    const nextCornerMarkers = currentTemplate.cornerMarkers.map((marker) => {
      const cornerWindow = windows.find((window) => window.id === marker.id);
      if (!cornerWindow) {
        return marker;
      }
      const nextWidth = Math.max(0.004, marker.w);
      const nextHeight = Math.max(0.004, marker.h);
      const centerX = cornerWindow.x + cornerWindow.w / 2;
      const centerY = cornerWindow.y + cornerWindow.h / 2;
      return {
        ...marker,
        x: Math.min(1 - nextWidth, Math.max(0, centerX - nextWidth / 2)),
        y: Math.min(1 - nextHeight, Math.max(0, centerY - nextHeight / 2)),
        w: nextWidth,
        h: nextHeight
      };
    });

    const nextTemplate: OMRTemplate = {
      ...currentTemplate,
      cornerSearchWindows: searchWindows,
      cornerMarkers: nextCornerMarkers
    };
    if (activeVisualFileId) {
      const existingOverride = fileTemplateOverridesRef.current[activeVisualFileId] ?? {};
      fileTemplateOverridesRef.current[activeVisualFileId] = {
        ...existingOverride,
        cornerSearchWindows: searchWindows
      };
    }
    setActiveTemplate(nextTemplate);
    setVisualDialogError(null);
    setVisualSteps((current) =>
      current.map((step) => (step.id === "corners" ? { ...step, cornerWindows: windows } : step))
    );
    void rebuildVisualStepsForTemplate(nextTemplate, "Refreshing transformed sheet preview...");
  };

  const captureCornerSnapshots = (
    snapshots: Partial<Record<CornerWindowVisual["id"], CornerSnapshot>>
  ) => {
    if (!activeVisualFileId) {
      return;
    }
    const existingOverride = fileTemplateOverridesRef.current[activeVisualFileId] ?? {};
    fileTemplateOverridesRef.current[activeVisualFileId] = {
      ...existingOverride,
      cornerSnapshots: {
        ...(existingOverride.cornerSnapshots ?? {}),
        ...snapshots
      }
    };
    updateQueueItem(activeVisualFileId, (item) => ({
      ...item,
      status: "queued",
      detail: "File-specific corner snapshots updated. Reprocessing..."
    }));
    setAutoProcessTick((value) => value + 1);
    setVisualDialogStage(
      "Corner snapshots saved for this file only. The file was queued for reprocessing."
    );
  };

  const applyRoiBoxes = async (boxes: RoiBoxVisual[]) => {
    const nextTemplate = applyRoiBoxesToTemplate(activeTemplateRef.current, boxes);
    setActiveTemplate(nextTemplate);
    setVisualDialogError(null);
    const rectifiedStep = visualSteps.find((step) => step.id === "rectified");
    if (rectifiedStep?.imageDataUrl) {
      setVisualDialogLoading(true);
      setVisualDialogError(null);
      setVisualDialogStage("Updating ROI overlays without re-warping sheet...");
      try {
        const { regionsStep, readAreasStep } = await buildRoiReadAreaStepsFromRectifiedDataUrl(
          rectifiedStep.imageDataUrl,
          nextTemplate,
          (stage) => setVisualDialogStage(stage)
        );
        setVisualSteps((current) =>
          current.map((step) => {
            if (step.id === "regions") return regionsStep;
            if (step.id === "read-areas") return readAreasStep;
            return step;
          })
        );
      } catch {
        await rebuildVisualStepsForTemplate(nextTemplate, "Refreshing ROI preview...");
      } finally {
        setVisualDialogLoading(false);
        setVisualDialogStage(null);
      }
      return;
    }
    await rebuildVisualStepsForTemplate(nextTemplate, "Refreshing ROI preview...");
  };

  const handleSidebarToggle = () => {
    if (isMobileViewport) {
      setIsMobileDrawerOpen((value) => !value);
      return;
    }
    setIsSidebarCollapsed((value) => !value);
  };

  const closeMobileDrawer = () => {
    if (isMobileViewport) {
      setIsMobileDrawerOpen(false);
    }
  };

  const applyDarknessThreshold = (nextValue: number) => {
    const normalized = clampThreshold(nextValue);
    setDarknessThreshold(normalized);
    referenceTemplateRef.current = {
      ...referenceTemplateRef.current,
      scoring: {
        ...(referenceTemplateRef.current.scoring ?? {}),
        darknessThreshold: normalized
      }
    };
    setActiveTemplate((current) => ({
      ...current,
      scoring: {
        ...(current.scoring ?? {}),
        darknessThreshold: normalized
      }
    }));
  };

  const applyCornerAngleTolerance = (nextValue: number) => {
    const normalized = clampCornerAngleTolerance(nextValue);
    setCornerAngleToleranceDegrees(normalized);
    referenceTemplateRef.current = {
      ...referenceTemplateRef.current,
      scoring: {
        ...(referenceTemplateRef.current.scoring ?? {}),
        cornerAngleToleranceDegrees: normalized
      }
    };
    setActiveTemplate((current) => ({
      ...current,
      scoring: {
        ...(current.scoring ?? {}),
        cornerAngleToleranceDegrees: normalized
      }
    }));
  };

  const buildExcelRow = (item: QueueFileItem): string[] => {
    const row = new Array<string>(excelHeaders.length).fill("");
    row[0] = item.name;
    if (!item.result) {
      return row;
    }

    const studentDigits = item.result.student.studentId.detected ?? [];
    for (let index = 0; index < 6; index += 1) {
      const digit = studentDigits[index];
      row[1 + index] =
        typeof digit === "number" && digit >= 0 ? String(digit) : "";
    }

    const examCodeDigits = item.result.student.examCode.detected ?? [];
    for (let index = 0; index < 3; index += 1) {
      const digit = examCodeDigits[index];
      row[7 + index] =
        typeof digit === "number" && digit >= 0 ? String(digit) : "";
    }

    row[10] = item.result.student.examSet.selected?.[0] ?? "";

    for (let q = 1; q <= 100; q += 1) {
      const answer = item.result.answers.find((entry) => entry.q === q);
      const answerText = answer?.selected?.join(",") ?? "";
      if (q <= 35) {
        row[11 + (q - 1)] = answerText;
      } else if (q <= 70) {
        row[46 + (q - 36)] = answerText;
      } else {
        row[81 + (q - 71)] = answerText;
      }
    }

    return row;
  };

  const exportResultsToExcel = async () => {
    const doneRows = queueRef.current.filter((item) => item.result);
    if (doneRows.length === 0) {
      setError("No processed JSON results available to export.");
      return;
    }
    setExportBusy(true);
    setError(null);
    try {
      const rows = [Array.from(excelHeaders), ...doneRows.map((item) => buildExcelRow(item))];
      const ExcelJsModule = await import("exceljs");
      const workbook = new ExcelJsModule.Workbook();
      const worksheet = workbook.addWorksheet("results", {
        views: [{ state: "frozen", ySplit: 1 }]
      });

      worksheet.addRows(rows);

      for (let col = 1; col <= excelHeaders.length; col += 1) {
        let maxLen = 0;
        for (let row = 1; row <= rows.length; row += 1) {
          const rawValue = worksheet.getRow(row).getCell(col).value;
          const textValue =
            rawValue === null || rawValue === undefined
              ? ""
              : typeof rawValue === "object" && "text" in rawValue
                ? String(rawValue.text ?? "")
                : String(rawValue);
          maxLen = Math.max(maxLen, textValue.length);
        }
        worksheet.getColumn(col).width = Math.min(60, Math.max(10, maxLen + 2));
      }

      if (rows.length >= 2 && excelHeaders.length >= 2) {
        const lastColumnLetter = columnIndexToExcelLetter(excelHeaders.length);
        worksheet.addConditionalFormatting({
          ref: `B2:${lastColumnLetter}${rows.length}`,
          rules: [
            {
              type: "expression",
              priority: 1,
              formulae: ['AND(B$1<>"",$A2<>"",B2="")'],
              style: {
                fill: {
                  type: "pattern",
                  pattern: "solid",
                  fgColor: { argb: "FFFFEB9C" },
                  bgColor: { argb: "FFFFEB9C" }
                },
                font: {
                  color: { argb: "FF9C6500" }
                }
              }
            }
          ]
        });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputBuffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([outputBuffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `aerc-omr-results-${timestamp}.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Unable to export Excel file.");
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <main className="main dashboard-main">
      <header className="appbar">
        <div className="appbar-left">
          <button className="appbar-menu" onClick={handleSidebarToggle} type="button" aria-label="Toggle sidebar">
            ☰
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="appbar-logo" src="/reference/aerc-logo.png" alt="AERC logo" />
          <strong>AERC OMR Scanner App</strong>
        </div>
        <div className="appbar-right">
          <button className="appbar-collapse" onClick={handleSidebarToggle} type="button">
            {isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          </button>
        </div>
      </header>
      <section
        className={`dashboard-shell${isSidebarCollapsed ? " sidebar-collapsed" : ""}${
          isMobileDrawerOpen ? " drawer-open" : ""
        }`}
      >
        <button
          className={`drawer-backdrop${isMobileDrawerOpen ? " drawer-backdrop-visible" : ""}`}
          onClick={closeMobileDrawer}
          aria-label="Close sidebar drawer"
          type="button"
        />
        <aside className="dashboard-sidebar">
          <div className="sidebar-brand">
            <strong>AERC</strong>
            <span>Since 1999</span>
          </div>
          <button className="sidebar-close" onClick={closeMobileDrawer} type="button">
            Close
          </button>
          <nav className="sidebar-nav">
            <button className="sidebar-link sidebar-link-active" onClick={closeMobileDrawer}>Scanner</button>
          </nav>
        </aside>

        <section className="dashboard-content">
          <header className="dashboard-header">
            <div>
              <h1 className="dashboard-title">AERC OMR Scanner App</h1>
              <p className="subtle-text">Upload files and they are processed automatically.</p>
              <label className="threshold-control">
                Darkness Threshold
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={darknessThreshold}
                  onChange={(event) => applyDarknessThreshold(Number(event.target.value))}
                />
              </label>
              <label className="threshold-control">
                Corner Angle Tolerance (°)
                <input
                  type="number"
                  min={0.5}
                  max={30}
                  step={0.1}
                  value={cornerAngleToleranceDegrees}
                  onChange={(event) => applyCornerAngleTolerance(Number(event.target.value))}
                />
              </label>
            </div>
          </header>

          <section
            className={`upload-dropzone${dragActive ? " upload-dropzone-active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              addFilesToQueue(Array.from(event.dataTransfer.files));
            }}
          >
            <h3>Drag and drop OMR files here</h3>
            <p>Supports PNG, JPG, or WEBP.</p>
            <input
              id="omr-file-input"
              ref={fileInputRef}
              className="drop-area-input"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                addFilesToQueue(Array.from(event.target.files ?? []));
                event.currentTarget.value = "";
              }}
            />
            <label htmlFor="omr-file-input" className="drop-action">Browse Files</label>
          </section>

          <section className="queue-section">
            <header>
              <div className="queue-header-left">
                <h3>Processing Queue ({queue.length})</h3>
                {!scanTemplateReady ? <span className="subtle-text">Loading template...</span> : null}
              </div>
              <div className="queue-header-actions">
                {loading ? <button onClick={cancelBatch}>Cancel</button> : null}
                <button
                  className="excel-export-button"
                  onClick={() => void exportResultsToExcel()}
                  disabled={exportBusy || queue.every((item) => !item.result)}
                >
                  <span className="excel-icon" aria-hidden="true">
                    X
                  </span>{" "}
                  {exportBusy ? "Exporting..." : "Export Excel"}
                </button>
                <button className="destructive-filled" onClick={deleteAllFiles} disabled={queue.length === 0}>
                  Delete All
                </button>
              </div>
            </header>
            {scanStage ? (
              <div className="processing-progress-panel">
                <strong>Progress Details</strong>
                <p>{scanStage}</p>
              </div>
            ) : null}
            {activeIssueDefinitions.length > 0 ? (
              <div className="issue-chip-row">
                {activeIssueDefinitions.map((definition) => (
                  <button
                    key={definition.key}
                    type="button"
                    className={`issue-chip issue-chip-${definition.kind}${
                      selectedIssueFilters.includes(definition.key)
                        ? " issue-chip-active"
                        : ""
                    }`}
                    onClick={() => toggleIssueFilter(definition.key)}
                  >
                    {definition.label} ({issueCounts[definition.key]})
                  </button>
                ))}
              </div>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            {queue.length === 0 ? (
              <p className="subtle-text">No files added yet.</p>
            ) : filteredQueue.length === 0 ? (
              <p className="subtle-text">No files match selected warning/error filters.</p>
            ) : (
              <div className="queue-list">
                {filteredQueue.map((item) => (
                  <article key={item.id} className="queue-card">
                    <div>
                      <strong>{item.name}</strong>
                      <div className="file-issue-chip-row">
                        {(() => {
                          const issues = issueMapByFileId.get(item.id) ?? [];
                          if (issues.length > 0) {
                            return issues.map((key) => {
                              const definition = issueDefinitions.find((entry) => entry.key === key);
                              return (
                                <span
                                  key={`${item.id}-${key}`}
                                  className={`issue-chip issue-chip-${definition?.kind ?? "warning"} issue-chip-card`}
                                >
                                  {definition?.label ?? key}
                                </span>
                              );
                            });
                          }
                          if (item.status === "done" && item.result) {
                            return (
                              <span className="issue-chip issue-chip-ok issue-chip-card" key={`${item.id}-ok`}>
                                Okay
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </div>
                      <p className="subtle-text">{formatBytes(item.size)}</p>
                    </div>
                    <div className="queue-actions">
                      {item.status !== "done" ? (
                        <span className={`processing-badge processing-${item.status}`}>{item.status}</span>
                      ) : null}
                      <button onClick={() => void openTransformReview(item.id)} disabled={!item.result}>
                        Review Scan
                      </button>
                      <button
                        className="queue-icon-button"
                        title="Visual Parse / Template"
                        aria-label="Visual Parse / Template"
                        onClick={() => void openVisualDialog(item.id)}
                      >
                        ⚙
                      </button>
                      <button
                        className="queue-icon-button"
                        title="Override / JSON"
                        aria-label="Override / JSON"
                        onClick={() => openOverrideDialog(item.id)}
                        disabled={!item.result}
                      >
                        {"{}"}
                      </button>
                      <button
                        className="queue-icon-button queue-icon-button-destructive"
                        title="Delete file"
                        aria-label="Delete file"
                        onClick={() => deleteFromQueue(item.id)}
                      >
                        🗑
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>
      </section>

      {overrideItem ? (
        <div
          className="override-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setOverrideFileId(null);
              setOverrideDraft("");
              setOverrideError(null);
            }
          }}
        >
          <section className="override-dialog" role="dialog" aria-modal="true">
            <header className="modal-header">
              <h2>Override Result — {overrideItem.name}</h2>
              <button
                onClick={() => {
                  setOverrideFileId(null);
                  setOverrideDraft("");
                  setOverrideError(null);
                }}
              >
                Close
              </button>
            </header>
            <p className="subtle-text">Edit JSON override for this file.</p>
            <textarea
              className="override-json"
              value={overrideDraft}
              onChange={(event) => setOverrideDraft(event.target.value)}
            />
            {overrideError ? <p className="error">{overrideError}</p> : null}
            <div className="actions">
              <button onClick={applyOverride}>Apply Override</button>
            </div>
          </section>
        </div>
      ) : null}
      {transformReview.isOpen ? (
        <div
          className="override-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setTransformReview({
                isOpen: false,
                loading: false,
                error: null,
                fileId: null,
                fileName: "",
                overlayUrl: null,
                summaryLines: []
              });
            }
          }}
        >
          <section className="transform-review-dialog" role="dialog" aria-modal="true">
            <header className="modal-header">
              <h2>Transformed ROI Review — {transformReview.fileName}</h2>
              <button
                onClick={() =>
                  setTransformReview({
                    isOpen: false,
                    loading: false,
                    error: null,
                    fileId: null,
                    fileName: "",
                    overlayUrl: null,
                    summaryLines: []
                  })
                }
              >
                Close
              </button>
            </header>
            {transformReview.loading ? <p className="subtle-text">Preparing transformed preview...</p> : null}
            {transformReview.error ? <p className="error">{transformReview.error}</p> : null}
            {!transformReview.loading && !transformReview.error ? (
              <div className="transform-review-grid">
                <div className="transform-preview-pane">
                  {transformReview.overlayUrl ? (
                    <div className="transform-overlay-stage">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={transformReview.overlayUrl} alt="Transformed ROI overlay" />
                      {transformReviewItem?.result ? (
                        <div className="transform-hotspot-layer" aria-label="Interactive ROI override layer">
                          {referenceTemplateRef.current.studentId.columns.flatMap((row, rowIndex) =>
                            row.map((bubble, digit) => {
                              const active =
                                transformReviewItem.result?.student.studentId.detected[rowIndex] === digit;
                              const isVacantRow =
                                (transformReviewItem.result?.student.studentId.detected[rowIndex] ?? "") === "";
                              return (
                                <button
                                  key={`overlay-student-${rowIndex}-${digit}`}
                                  type="button"
                                  title={`Student ID digit ${rowIndex + 1}: ${digit}`}
                                  aria-label={`Student ID digit ${rowIndex + 1}, set ${digit}`}
                                  className={`transform-overlay-checkbox transform-overlay-checkbox-student${
                                    active ? " transform-overlay-checkbox-active" : ""
                                  }${isVacantRow ? " transform-overlay-checkbox-vacant" : ""}`}
                                  style={{
                                    left: `${bubble.x * 100}%`,
                                    top: `${bubble.y * 100}%`,
                                    width: `${bubble.w * 100}%`,
                                    height: `${bubble.h * 100}%`
                                  }}
                                  onClick={() =>
                                    applyTransformDigitOverride(
                                      "studentId",
                                      rowIndex,
                                      active ? "" : digit
                                    )
                                  }
                                />
                              );
                            })
                          )}
                          {referenceTemplateRef.current.examCode.columns.flatMap((row, rowIndex) =>
                            row.map((bubble, digit) => {
                              const active =
                                transformReviewItem.result?.student.examCode.detected[rowIndex] === digit;
                              const isVacantRow =
                                (transformReviewItem.result?.student.examCode.detected[rowIndex] ?? "") === "";
                              return (
                                <button
                                  key={`overlay-exam-code-${rowIndex}-${digit}`}
                                  type="button"
                                  title={`Exam Code digit ${rowIndex + 1}: ${digit}`}
                                  aria-label={`Exam Code digit ${rowIndex + 1}, set ${digit}`}
                                  className={`transform-overlay-checkbox transform-overlay-checkbox-exam-code${
                                    active ? " transform-overlay-checkbox-active" : ""
                                  }${isVacantRow ? " transform-overlay-checkbox-vacant" : ""}`}
                                  style={{
                                    left: `${bubble.x * 100}%`,
                                    top: `${bubble.y * 100}%`,
                                    width: `${bubble.w * 100}%`,
                                    height: `${bubble.h * 100}%`
                                  }}
                                  onClick={() =>
                                    applyTransformDigitOverride(
                                      "examCode",
                                      rowIndex,
                                      active ? "" : digit
                                    )
                                  }
                                />
                              );
                            })
                          )}
                          {(Object.entries(referenceTemplateRef.current.examSet.choices) as Array<
                            [ChoiceLabel, (typeof referenceTemplateRef.current.examSet.choices)[ChoiceLabel]]
                          >).map(([choice, bubble]) => {
                            const active =
                              transformReviewItem.result?.student.examSet.selected.includes(choice) ?? false;
                            const isVacant =
                              (transformReviewItem.result?.student.examSet.selected?.length ?? 0) === 0;
                            return (
                              <button
                                key={`overlay-exam-set-${choice}`}
                                type="button"
                                title={`Exam Set ${choice}`}
                                aria-label={`Exam Set ${choice}`}
                                className={`transform-overlay-checkbox transform-overlay-checkbox-exam-set${
                                  active ? " transform-overlay-checkbox-active" : ""
                                }${isVacant ? " transform-overlay-checkbox-vacant" : ""}`}
                                style={{
                                  left: `${bubble.x * 100}%`,
                                  top: `${bubble.y * 100}%`,
                                  width: `${bubble.w * 100}%`,
                                  height: `${bubble.h * 100}%`
                                }}
                                onClick={() => applyTransformExamSetOverride(choice)}
                              />
                            );
                          })}
                          {referenceTemplateRef.current.answers.flatMap((answer) =>
                            (Object.entries(answer.choices) as Array<
                              [ChoiceLabel, (typeof answer.choices)[ChoiceLabel]]
                            >).map(([choice, bubble]) => {
                              const selected = answerSelectionByQuestion.get(answer.question) ?? [];
                              const active = selected.includes(choice);
                              const isVacant = selected.length === 0;
                              return (
                                <button
                                  key={`overlay-answer-${answer.question}-${choice}`}
                                  type="button"
                                  title={`Q${answer.question} ${choice}`}
                                  aria-label={`Question ${answer.question}, choice ${choice}`}
                                  className={`transform-overlay-checkbox transform-overlay-checkbox-answer${
                                    active ? " transform-overlay-checkbox-active" : ""
                                  }${isVacant ? " transform-overlay-checkbox-vacant" : ""}`}
                                  style={{
                                    left: `${bubble.x * 100}%`,
                                    top: `${bubble.y * 100}%`,
                                    width: `${bubble.w * 100}%`,
                                    height: `${bubble.h * 100}%`
                                  }}
                                  onClick={() => applyTransformAnswerOverride(answer.question, choice)}
                                />
                              );
                            })
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="subtle-text">ROI overlay not available.</p>
                  )}
                </div>
                <div className="transform-summary-pane">
                  <h3>Detected Shades Summary</h3>
                  <ul>
                    {transformReview.summaryLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="subtle-text">
                    Override values directly on the transformed image by clicking the checkbox chips on each ROI
                    bubble (Student ID, Exam Code, Exam Set, and Answers 1–100).
                  </p>
                  {transformReviewItem?.result ? (
                    <div className="transform-answer-panel">
                      <h4>Detected Answers</h4>
                      <div className="transform-answer-list" role="list" aria-label="Detected answers list">
                        {transformReviewItem.result.answers.map((answer) => {
                          const selected = answer.selected ?? [];
                          const isVacant = selected.length === 0;
                          return (
                            <div
                              key={`answer-row-${answer.q}`}
                              role="listitem"
                              className="transform-answer-row"
                            >
                              <strong>Q{String(answer.q).padStart(3, "0")}</strong>
                              <span>{isVacant ? "(vacant)" : selected.join(",")}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
      <VisualParsingDialog
        isOpen={visualDialogOpen}
        loading={visualDialogLoading}
        stage={visualDialogStage}
        error={visualDialogError}
        steps={visualSteps}
        onApplyCornerWindows={applyCornerWindows}
        onCaptureCornerSnapshots={captureCornerSnapshots}
        onApplyRoiBoxes={applyRoiBoxes}
        onClose={() => {
          setVisualDialogOpen(false);
          setActiveVisualFileId(null);
        }}
      />
    </main>
  );
}
