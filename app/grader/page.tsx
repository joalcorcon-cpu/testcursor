import type { Metadata } from "next";
import { ExamGraderDashboard } from "@/components/ExamGraderDashboard";

export const metadata: Metadata = {
  title: "Photo Exam Grader | AERC",
  description: "Grade AERC answer-sheet photos locally with OpenCV."
};

export default function GraderPage() {
  return <ExamGraderDashboard />;
}
