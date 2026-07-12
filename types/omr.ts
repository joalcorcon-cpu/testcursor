export type ChoiceLabel = "A" | "B" | "C" | "D";

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
  confidence: number;
  ambiguous: boolean;
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
