"use client";

import type { VisualParseStep } from "@/lib/omr/buildVisualParsingSteps";

interface VisualParsingDialogProps {
  isOpen: boolean;
  loading: boolean;
  stage: string | null;
  error: string | null;
  steps: VisualParseStep[];
  onClose: () => void;
}

export function VisualParsingDialog({
  isOpen,
  loading,
  stage,
  error,
  steps,
  onClose
}: VisualParsingDialogProps) {
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
