/**
 * Symphony operational console (SPEC §13.7.1). Server sends a minimal app shell
 * with the first snapshot embedded for instant paint; the client app (`./ui/`,
 * plain ES modules rendered with lit-html, served at `/ui/*`) then opens an SSE
 * stream for live updates, degrading to polling when the stream is unavailable.
 * Drawn solely from orchestrator state — never required for correctness.
 */
import type { SnapshotView } from "../orchestrator/orchestrator.ts";
import type { ProjectSummary } from "../project/manager.ts";

/** Everything the console shell needs to paint the selected project instantly. */
export interface DashboardBootstrap {
  projects: ProjectSummary[];
  can_add: boolean;
  selected: string;
  snapshot: SnapshotView | null;
}

/** Render the console shell with the selected project's snapshot inlined (progressive enhancement). */
export function renderDashboard(boot: DashboardBootstrap): string {
  const bootstrap = JSON.stringify(boot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony · console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/ui/styles.css">
</head>
<body>
<div id="app" aria-busy="false"></div>
<div id="toast-root" aria-live="polite"></div>
<script>window.__SYMPHONY__ = ${bootstrap};</script>
<script type="module" src="/ui/app.js"></script>
</body>
</html>`;
}
