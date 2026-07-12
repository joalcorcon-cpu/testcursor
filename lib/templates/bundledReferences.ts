import type { BubbleRegion, CornerMarker } from "@/types/omr";

export interface BundledReferenceImage {
  id: string;
  title: string;
  description: string;
  href: string;
}

export const bundledReferenceImages: BundledReferenceImage[] = [
  {
    id: "sample-answer-sheet",
    title: "Sample Answer Sheet",
    description: "Reference answer sheet layout used by the premade template.",
    href: "/reference/answer-sheet-reference.jpg"
  },
  {
    id: "corner-tl",
    title: "Corner Snapshot TL",
    description: "Top-left corner snapshot used for matchTemplate.",
    href: "/reference/corners/tl-snapshot.jpg"
  },
  {
    id: "corner-tr",
    title: "Corner Snapshot TR",
    description: "Top-right corner snapshot used for matchTemplate.",
    href: "/reference/corners/tr-snapshot.jpg"
  },
  {
    id: "corner-br",
    title: "Corner Snapshot BR",
    description: "Bottom-right corner snapshot used for matchTemplate.",
    href: "/reference/corners/br-snapshot.jpg"
  },
  {
    id: "corner-bl",
    title: "Corner Snapshot BL",
    description: "Bottom-left corner snapshot used for matchTemplate.",
    href: "/reference/corners/bl-snapshot.jpg"
  }
];

export const bundledCornerSnapshotSources: Record<CornerMarker["id"], string> = {
  tl: "/reference/corners/tl-snapshot.jpg",
  tr: "/reference/corners/tr-snapshot.jpg",
  br: "/reference/corners/br-snapshot.jpg",
  bl: "/reference/corners/bl-snapshot.jpg"
};

// Script-provided Shadebox rectangles, normalized to transformed sheet dimensions.
export const scriptShadeboxRoiCalibrationBoxes: Record<
  "studentId" | "examCode" | "examSet" | "answersCol1" | "answersCol2" | "answersCol3",
  BubbleRegion
> = {
  studentId: {
    x: 150 / 1683,
    y: 455 / 2167,
    w: 446 / 1683,
    h: 320 / 2167
  },
  examCode: {
    x: 185 / 2019,
    y: 1235 / 2615,
    w: 528 / 2019,
    h: 192 / 2615
  },
  examSet: {
    x: 179 / 2019,
    y: 1528 / 2615,
    w: 232 / 2019,
    h: 70 / 2615
  },
  answersCol1: {
    x: 923 / 2019,
    y: 273 / 2615,
    w: 220 / 2019,
    h: 2228 / 2615
  },
  answersCol2: {
    x: 1317 / 2019,
    y: 273 / 2615,
    w: 218 / 2019,
    h: 2228 / 2615
  },
  answersCol3: {
    x: 1708 / 2019,
    y: 273 / 2615,
    w: 220 / 2019,
    h: 1913 / 2615
  }
};
