export type ChoiceLabel = "A" | "B" | "C" | "D";
export type OMRProcessingMode = "legacy" | "grading-v2";
export type OMRMarkState = "single" | "blank" | "ambiguous";
export type PaperLocalizationStrategy = "paper-crop" | "full-image-fallback";

export interface ImagePoint {
  x: number;
  y: number;
}

export interface PaperDetectionDiagnostics {
  detected: boolean;
  confidence: number;
  polygon: ImagePoint[] | null;
  strategy: PaperLocalizationStrategy;
  fallbackReason?: string;
}

export interface PhotoQualityReport {
  processingMode: OMRProcessingMode;
  sourceWidth: number;
  sourceHeight: number;
  sharpnessScore: number;
  localContrast: number;
  clippedDarkRatio: number;
  clippedLightRatio: number;
  markersDetected: number;
  markersUsed: number;
  warpSucceeded: boolean;
  paperDetection: PaperDetectionDiagnostics;
  columnAlignmentConfidence: number[];
  columnAlignmentOffsets: Array<{ dx: number; dy: number }>;
  ambiguousAnswerRatio: number;
  warnings: string[];
  blockingReasons: string[];
}

export interface ImagingProcessStep {
  id:
    | "original"
    | "paper"
    | "paper-crop"
    | "fiducials"
    | "rectified"
    | "background-normalized"
    | "clahe"
    | "column-alignment"
    | "final-detection";
  title: string;
  description: string;
  imageUrl: string;
}

export interface ImagingProcessStepPayload
  extends Omit<ImagingProcessStep, "imageUrl"> {
  rgbaBuffer?: ArrayBuffer;
  width: number;
  height: number;
}

export interface GradingVisualizationPayload {
  steps: ImagingProcessStepPayload[];
  paperDetection: PaperDetectionDiagnostics;
  columnAlignmentConfidence: number[];
  columnAlignmentOffsets: Array<{ dx: number; dy: number }>;
  blockingReason?: string;
}

export interface BubbleRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CornerMarker {
  id: "tl" | "tr" | "br" | "bl";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CornerSnapshot {
  id: CornerMarker["id"];
  width: number;
  height: number;
  grayscale: number[];
  centroidX?: number;
  centroidY?: number;
}

export interface DigitColumnRegion {
  key: string;
  digits: number;
  bubbleRows: number;
  columns: BubbleRegion[][];
}

export interface AnswerItemRegion {
  question: number;
  choices: Record<ChoiceLabel, BubbleRegion>;
}

export interface ExamSetRegion {
  choices: Record<ChoiceLabel, BubbleRegion>;
}

export interface OMRTemplate {
  id: string;
  name: string;
  version: number;
  sheetWidth: number;
  sheetHeight: number;
  cornerMarkers: CornerMarker[];
  cornerSearchWindows?: Partial<Record<CornerMarker["id"], BubbleRegion>>;
  cornerSnapshots?: Partial<Record<CornerMarker["id"], CornerSnapshot>>;
  scoring?: {
    darknessThreshold?: number;
    cornerAngleToleranceDegrees?: number;
  };
  roiCalibrationBoxes?: Partial<
    Record<
      "studentId" | "examCode" | "examSet" | "answersCol1" | "answersCol2" | "answersCol3",
      BubbleRegion
    >
  >;
  studentId: DigitColumnRegion;
  examCode: DigitColumnRegion;
  examSet: ExamSetRegion;
  answers: AnswerItemRegion[];
}

export interface ChoiceScores {
  A: number;
  B: number;
  C: number;
  D: number;
}

export interface OMRAnswerJson {
  q: number;
  selected: ChoiceLabel[];
  shadeScores: ChoiceScores;
  normalizedScores?: ChoiceScores;
  confidence: number;
  ambiguous: boolean;
  markState?: OMRMarkState;
}

export interface OMRDigitJson {
  detected: Array<number | "">;
  shadeScores: number[][];
}

export interface OMRSetJson {
  selected: ChoiceLabel[];
  shadeScores: ChoiceScores;
  confidence: number;
  ambiguous: boolean;
}

export interface OMRResultJson {
  templateId: string;
  student: {
    studentId: OMRDigitJson;
    examCode: OMRDigitJson;
    examSet: OMRSetJson;
  };
  answers: OMRAnswerJson[];
  pipeline: {
    warped: boolean;
    width: number;
    height: number;
    cornerFoundCount?: number;
    cornerUsedCount?: number;
    cornerTriangulatedCount?: number;
    cornerAngles?: {
      tl: number;
      tr: number;
      br: number;
      bl: number;
    };
    cornerUneven?: boolean;
    quality?: PhotoQualityReport;
  };
}

export interface ScanRecord {
  id: string;
  scan_session_id: string;
  template_id: string;
  source_name: string;
  result_json: OMRResultJson;
  created_at: string;
}
