"use client";

import { useState } from "react";
import type { ScanRecord } from "@/types/omr";

export default function ResultsPage() {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [sourceName, setSourceName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadScans = async () => {
    setError(null);
    const params = new URLSearchParams();
    if (sourceName) params.set("sourceName", sourceName);
    if (templateId) params.set("templateId", templateId);
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(to).toISOString());

    const response = await fetch(`/api/scans?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Failed to load scans.");
      return;
    }
    setScans(payload.scans ?? []);
  };

  return (
    <main className="main">
      <h1>Results</h1>
      <p className="subtitle">Filter and review stored scan JSON metadata.</p>
      <section className="card">
        <div className="field-grid">
          <label>
            Source name
            <input value={sourceName} onChange={(event) => setSourceName(event.target.value)} />
          </label>
          <label>
            Template ID
            <input value={templateId} onChange={(event) => setTemplateId(event.target.value)} />
          </label>
          <label>
            From
            <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            To
            <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button onClick={() => void loadScans()}>Apply filters</button>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {scans.length === 0 ? (
          <p>No scans loaded.</p>
        ) : (
          <ul>
            {scans.map((scan) => (
              <li key={scan.id}>
                <strong>{scan.source_name}</strong> · {scan.template_id} ·{" "}
                {new Date(scan.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
