import { ScanWorkspace } from "@/components/ScanWorkspace";

export default function HomePage() {
  return (
    <main className="main">
      <h1>OMR Answer Sheet Scanner</h1>
      <p className="subtitle">
        OpenCV.js runs in browser. Supabase stores template and scan JSON metadata only.
      </p>
      <ScanWorkspace />
    </main>
  );
}
