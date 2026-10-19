import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { expect } from "vitest";

import { waitForBrowserDevtoolsPort } from "../../../src/browser/BrowserProcessStartup.js";
import { createBrowserScenarioProvider } from "../../../src/composition/browserScenario.js";
import { browserScenarioSchema } from "../../../src/domain/browserScenario.js";
import type { BrowserScenarioCapture } from "../../../src/domain/browserScenarioCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest as it } from "../../support/process/processFixture.js";

const chromeExecutable = [
  process.env.REA_BROWSER_EXECUTABLE,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(
  (candidate): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    existsSync(candidate),
);

const CHROME_STARTUP_TIMEOUT_MS = 60_000;
const CHROME_TEST_TIMEOUT_MS = CHROME_STARTUP_TIMEOUT_MS + 60_000;

// Native HTML5 drag and drop: the page records each drag event in #log and
// marks the zone while dragover fires, so a mid-drag DOM capture shows it.
const nativeHtml = `<!doctype html><title>native</title>
<style>
  #card { position: absolute; left: 40px; top: 40px; width: 120px; height: 40px; background: #ddd; }
  #zone { position: absolute; left: 300px; top: 40px; width: 200px; height: 200px; background: #eef; }
</style>
<div id="card" draggable="true">card</div>
<div id="zone">zone</div>
<pre id="log"></pre>
<pre id="persisted"></pre>
<script>
  // Events also persist in sessionStorage so a later scenario on the same
  // attached tab can read what happened after the previous session closed.
  document.getElementById('persisted').textContent = 'persisted:' + (sessionStorage.getItem('events') ?? '');
  const log = (entry) => {
    document.getElementById('log').textContent += entry + ';';
    sessionStorage.setItem('events', (sessionStorage.getItem('events') ?? '') + entry + ';');
  };
  const card = document.getElementById('card');
  const zone = document.getElementById('zone');
  card.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', 'card'); log('dragstart'); });
  card.addEventListener('dragend', (event) => log('dragend:' + event.dataTransfer.dropEffect));
  zone.addEventListener('dragenter', (event) => { event.preventDefault(); log('dragenter'); });
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.dataset.over = 'true'; });
  zone.addEventListener('drop', (event) => { event.preventDefault(); log('drop'); });
</script>`;

// Pointer-driven drag (no HTML5 drag): the handle follows pointermove while the
// button is held, Escape cancels, and pointerup commits.
const pointerHtml = `<!doctype html><title>pointer</title>
<style>
  #handle { position: absolute; left: 40px; top: 40px; width: 80px; height: 40px; background: #ddd; touch-action: none; }
</style>
<div id="handle">handle</div>
<pre id="log"></pre>
<script>
  const log = (entry) => { document.getElementById('log').textContent += entry + ';'; };
  const handle = document.getElementById('handle');
  let origin = null;
  handle.addEventListener('pointerdown', (event) => { origin = { x: event.clientX, y: event.clientY }; log('down'); });
  window.addEventListener('pointermove', (event) => {
    if (origin === null) return;
    handle.dataset.dx = String(Math.round(event.clientX - origin.x));
    handle.dataset.dy = String(Math.round(event.clientY - origin.y));
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && origin !== null) { origin = null; log('cancelled'); }
  });
  window.addEventListener('pointerup', () => { log(origin === null ? 'up-after-cancel' : 'dropped'); origin = null; });
</script>`;

const listen = async (): Promise<{ server: Server; origin: string }> => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/pointer" ? pointerHtml : nativeHtml);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Drag fixture server did not bind a TCP port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
};

const domAfter = (capture: BrowserScenarioCapture, stepId: string): string => {
  const step = capture.steps.find((candidate) => candidate.step_id === stepId);
  expect(step?.status).toBe("completed");
  const dom = step?.artifacts.dom;
  if (dom?.state !== "captured") throw new Error(`No DOM after ${stepId}`);
  return dom.value.text;
};

const nativeActions = (mode: "drop" | "cancel") => [
  {
    step_id: "lift",
    action: "drag_start",
    locator: { kind: "css", selector: "#card" },
    timeout_ms: 5_000,
  },
  {
    step_id: "over",
    action: "drag_move",
    target: { kind: "locator", locator: { kind: "css", selector: "#zone" } },
    steps: 5,
    timeout_ms: 5_000,
  },
  { step_id: "end", action: "drag_end", mode, timeout_ms: 5_000 },
];

const capture = async (scenario: unknown): Promise<BrowserScenarioCapture> => {
  const provider = createBrowserScenarioProvider({});
  try {
    const result = await provider.captureScenario(
      browserScenarioSchema.parse(scenario),
    );
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    await provider.close?.();
  }
};

it.skipIf(chromeExecutable === undefined)(
  "holds a native drag across a mid-drag capture and cancels it without a drop",
  async () => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    const { server, origin } = await listen();
    try {
      for (const mode of ["cancel", "drop"] as const) {
        const result = await capture({
          browser: { mode: "launch", executable_path: executable },
          start_url: { url: `${origin}/native` },
          actions: nativeActions(mode),
          capture: { after_each_step: ["dom", "screenshot"], at_end: [] },
        });
        const midDrag = domAfter(result, "over");
        expect(midDrag).toContain("dragstart;dragenter;");
        expect(midDrag).toContain('data-over="true"');
        expect(midDrag).not.toContain("drop;");
        expect(
          result.steps.find((step) => step.step_id === "over")?.artifacts
            .screenshot.state,
        ).toBe("captured");
        const ended = domAfter(result, "end");
        if (mode === "cancel") expect(ended).not.toContain("drop;");
        else expect(ended).toContain("drop;");
      }
    } finally {
      server.close();
    }
  },
  CHROME_TEST_TIMEOUT_MS,
);

it.skipIf(chromeExecutable === undefined)(
  "drives a pointer-based drag by delta and cancels it with Escape",
  async () => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    const { server, origin } = await listen();
    try {
      const result = await capture({
        browser: { mode: "launch", executable_path: executable },
        start_url: { url: `${origin}/pointer` },
        actions: [
          {
            step_id: "lift",
            action: "drag_start",
            locator: { kind: "css", selector: "#handle" },
            threshold_px: 0,
            timeout_ms: 5_000,
          },
          {
            step_id: "away",
            action: "drag_move",
            target: { kind: "delta", x: 120, y: 60 },
            timeout_ms: 5_000,
          },
          { step_id: "end", action: "drag_end", mode: "cancel" },
        ],
        capture: { after_each_step: ["dom"], at_end: [] },
      });
      const midDrag = domAfter(result, "away");
      expect(midDrag).toContain('data-dx="120"');
      expect(midDrag).toContain('data-dy="60"');
      const ended = domAfter(result, "end");
      expect(ended).toContain("down;cancelled;up-after-cancel;");
      expect(ended).not.toContain("dropped;");
    } finally {
      server.close();
    }
  },
  CHROME_TEST_TIMEOUT_MS,
);

it.skipIf(chromeExecutable === undefined)(
  "cancels a held native drag in an attached browser when a later step fails",
  async ({ processes }) => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    const { server, origin } = await listen();
    const profile = await createTestTempDirectory("rea-drag-connect-");
    let stderr = "";
    const child = processes.spawn(executable, [
      "--headless=new",
      ...(process.env.REA_BROWSER_NO_SANDBOX === "true"
        ? ["--no-sandbox"]
        : []),
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-sync",
      `${origin}/native`,
    ]);
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });
    try {
      const port = await waitForBrowserDevtoolsPort({
        child,
        executable,
        activePortPath: join(profile, "DevToolsActivePort"),
        stderr: () => stderr,
        timeoutMs: CHROME_STARTUP_TIMEOUT_MS,
      });
      const endpoint = `http://127.0.0.1:${String(port)}`;
      const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as {
        id: string;
        type: string;
        url: string;
      }[];
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" && candidate.url.startsWith(origin),
      );
      if (target === undefined) throw new Error("Fixture page target missing");
      const result = await capture({
        browser: {
          mode: "connect",
          cdp_endpoint: endpoint,
          target_id: target.id,
        },
        start_url: { url: `${origin}/native` },
        actions: [
          ...nativeActions("drop").slice(0, 2),
          {
            step_id: "missing",
            action: "wait_for",
            locator: { kind: "css", selector: "#never" },
            state: "visible",
            timeout_ms: 300,
          },
          { step_id: "end", action: "drag_end", mode: "drop" },
        ],
        capture: { after_each_step: ["dom"], at_end: [] },
      });
      expect(domAfter(result, "over")).toContain('data-over="true"');
      expect(
        result.steps.find((step) => step.step_id === "missing")?.status,
      ).toBe("failed");
      // The session cancelled the held drag on close: the attached page never
      // received a drop, and a fresh scenario can start a new drag.
      const after = await capture({
        browser: {
          mode: "connect",
          cdp_endpoint: endpoint,
          target_id: target.id,
        },
        start_url: { url: `${origin}/native` },
        actions: [
          {
            step_id: "read",
            action: "wait_for_timeout",
            duration_ms: 1,
          },
        ],
        capture: { after_each_step: [], at_end: ["dom"] },
      });
      const final = after.steps.at(-1)?.artifacts.dom;
      if (final?.state !== "captured") throw new Error("No final DOM");
      expect(final.value.text).toMatch(/persisted:dragstart;dragenter;[^<]*/u);
      expect(final.value.text).not.toContain("drop;");
    } finally {
      server.close();
    }
  },
  CHROME_TEST_TIMEOUT_MS,
);
