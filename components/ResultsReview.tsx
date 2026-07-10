"use client";

import { useMemo, useState } from "react";
import type { ChoiceLabel, OMRResultJson, ScanRecord } from "@/types/omr";

interface ScanFilters {
  sourceName: string;
  templateId: string;
  from: string;
  to: string;
}

interface ResultsReviewProps {
  result: OMRResultJson | null;
  savedScans: ScanRecord[];
  saving: boolean;
  error: string | null;
  filters: ScanFilters;
  onFiltersChange: (filters: ScanFilters) => void;
  onResultChange: (next: OMRResultJson) => void;
  onSave: () => Promise<void>;
  onRefreshScans: () => Promise<void>;
}

const choiceOptions: Array<{ label: string; value: string }> = [
  { label: "None", value: "" },
  { label: "A", value: "A" },
  { label: "B", value: "B" },
  { label: "C", value: "C" },
  { label: "D", value: "D" },
  { label: "A,B", value: "A,B" },
  { label: "B,C", value: "B,C" },
  { label: "C,D", value: "C,D" }
];

const parseSelected = (value: string): ChoiceLabel[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is ChoiceLabel => ["A", "B", "C", "D"].includes(part));

export function ResultsReview({
  result,
  savedScans,
  saving,
  error,
  filters,
  onFiltersChange,
  onResultChange,
  onSave,
  onRefreshScans
}: ResultsReviewProps) {
  const [studentIdText, setStudentIdText] = useState("");
  const [examCodeText, setExamCodeText] = useState("");
  const [examSetText, setExamSetText] = useState("");
  const [questionNo, setQuestionNo] = useState(1);
  const [questionChoice, setQuestionChoice] = useState("");

  const prettyJson = useMemo(
    () => (result ? JSON.stringify(result, null, 2) : "No scan result yet."),
    [result]
  );

  const lowConfidence = useMemo(
    () =>
      result
        ? result.answers.filter((answer) => answer.ambiguous || answer.confidence < 0.12).slice(0, 15)
        : [],
    [result]
  );

  const applyStudentId = () => {
    if (!result) return;
    const detected = studentIdText
      .replace(/\D/g, "")
      .slice(0, result.student.studentId.detected.length)
      .split("")
      .map((digit) => Number(digit));
    if (detected.length === 0) return;
    onResultChange({
      ...result,
      student: {
        ...result.student,
        studentId: { ...result.student.studentId, detected }
      }
    });
  };

  const applyExamCode = () => {
    if (!result) return;
    const detected = examCodeText
      .replace(/\D/g, "")
      .slice(0, result.student.examCode.detected.length)
      .split("")
      .map((digit) => Number(digit));
    if (detected.length === 0) return;
    onResultChange({
      ...result,
      student: {
        ...result.student,
        examCode: { ...result.student.examCode, detected }
      }
    });
  };

  const applyExamSet = () => {
    if (!result) return;
    const selected = parseSelected(examSetText);
    onResultChange({
      ...result,
      student: {
        ...result.student,
        examSet: {
          ...result.student.examSet,
          selected,
          ambiguous: selected.length !== 1
        }
      }
    });
  };

  const applyAnswerCorrection = () => {
    if (!result) return;
    const index = questionNo - 1;
    if (index < 0 || index >= result.answers.length) return;
    const selected = parseSelected(questionChoice);
    const nextAnswers = [...result.answers];
    nextAnswers[index] = {
      ...nextAnswers[index],
      selected,
      ambiguous: selected.length !== 1
    };
    onResultChange({ ...result, answers: nextAnswers });
  };

  return (
    <section className="card">
      <h2>2) Review, correction, and save</h2>
      {error ? <p className="error">{error}</p> : null}

      <div className="field-grid">
        <label>
          Student ID override
          <div className="inline-row">
            <input
              type="text"
              value={studentIdText}
              onChange={(event) => setStudentIdText(event.target.value)}
              placeholder="e.g. 246135"
            />
            <button onClick={applyStudentId} disabled={!result}>
              Apply
            </button>
          </div>
        </label>
        <label>
          Exam Code override
          <div className="inline-row">
            <input
              type="text"
              value={examCodeText}
              onChange={(event) => setExamCodeText(event.target.value)}
              placeholder="e.g. 107"
            />
            <button onClick={applyExamCode} disabled={!result}>
              Apply
            </button>
          </div>
        </label>
        <label>
          Exam Set override
          <div className="inline-row">
            <select value={examSetText} onChange={(event) => setExamSetText(event.target.value)}>
              {choiceOptions.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button onClick={applyExamSet} disabled={!result}>
              Apply
            </button>
          </div>
        </label>
      </div>

      <div className="field-grid">
        <label>
          Correct answer item
          <div className="inline-row">
            <input
              type="number"
              min={1}
              max={100}
              value={questionNo}
              onChange={(event) => setQuestionNo(Number(event.target.value))}
            />
            <select
              value={questionChoice}
              onChange={(event) => setQuestionChoice(event.target.value)}
            >
              {choiceOptions.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button onClick={applyAnswerCorrection} disabled={!result}>
              Apply
            </button>
          </div>
        </label>
      </div>

      <div className="actions">
        <button onClick={() => void onSave()} disabled={!result || saving}>
          {saving ? "Saving..." : "Save JSON Result"}
        </button>
      </div>

      {lowConfidence.length > 0 ? (
        <>
          <h3>Low confidence / ambiguous answers</h3>
          <ul>
            {lowConfidence.map((item) => (
              <li key={item.q}>
                Q{item.q}: {item.selected.join(",") || "none"} (confidence {item.confidence.toFixed(3)})
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>JSON output</h3>
      <pre>{prettyJson}</pre>

      <h3>3) Stored scans with filters</h3>
      <div className="field-grid">
        <label>
          Source name
          <input
            type="text"
            value={filters.sourceName}
            onChange={(event) => onFiltersChange({ ...filters, sourceName: event.target.value })}
          />
        </label>
        <label>
          Template ID
          <input
            type="text"
            value={filters.templateId}
            onChange={(event) => onFiltersChange({ ...filters, templateId: event.target.value })}
          />
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={filters.from}
            onChange={(event) => onFiltersChange({ ...filters, from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={filters.to}
            onChange={(event) => onFiltersChange({ ...filters, to: event.target.value })}
          />
        </label>
      </div>
      <div className="actions">
        <button onClick={() => void onRefreshScans()}>Apply filters</button>
      </div>
      {savedScans.length === 0 ? (
        <p>No scans found for current filters.</p>
      ) : (
        <ul>
          {savedScans.map((scan) => (
            <li key={scan.id}>
              <strong>{scan.source_name}</strong> · {scan.template_id} ·{" "}
              {new Date(scan.created_at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
