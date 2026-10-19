import { expect, it, vi } from "vitest";
import type { Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import {
  performPlaywrightScenarioAction,
  releasePlaywrightScenarioDrag,
} from "./PlaywrightScenarioActions.js";

const scenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: "/opt/chromium" },
  start_url: { url: "https://app.example.test/" },
  actions: [
    {
      step_id: "hover",
      action: "hover",
      locator: { kind: "test_id", value: "card" },
      timeout_ms: 500,
    },
  ],
});
const secrets = BrowserScenarioSecrets.resolve(scenario, {});
if (secrets === undefined)
  throw new Error("Expected resolved scenario secrets");

it("hovers the declared locator within the action deadline", async () => {
  const hover = vi.fn(async () => undefined);
  const getByTestId = vi.fn(() => ({ hover }));
  const action = scenario.actions[0];
  if (action === undefined) throw new Error("Expected hover action");

  await performPlaywrightScenarioAction({
    page: { getByTestId } as unknown as Page,
    action,
    secrets,
  });

  expect(getByTestId).toHaveBeenCalledWith("card");
  expect(hover).toHaveBeenCalledWith({ timeout: 500 });
});

it("rejects a hover action without a locator", () => {
  expect(() =>
    browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
      start_url: { url: "https://app.example.test/" },
      actions: [{ step_id: "hover", action: "hover" }],
    }),
  ).toThrow();
});

const dragScenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: "/opt/chromium" },
  start_url: { url: "https://app.example.test/" },
  actions: [
    {
      step_id: "lift",
      action: "drag_start",
      locator: { kind: "test_id", value: "card" },
      timeout_ms: 500,
    },
    {
      step_id: "over",
      action: "drag_move",
      target: {
        kind: "locator",
        locator: { kind: "test_id", value: "column" },
        offset: { x: 10, y: 20 },
      },
      steps: 3,
      timeout_ms: 500,
    },
    {
      step_id: "nudge",
      action: "drag_move",
      target: { kind: "delta", x: 0, y: 40 },
    },
    { step_id: "release", action: "drag_end", mode: "cancel" },
  ],
});
const dragSecrets = BrowserScenarioSecrets.resolve(dragScenario, {});
if (dragSecrets === undefined)
  throw new Error("Expected resolved drag scenario secrets");

const dragPage = () => {
  const calls: string[] = [];
  const boxes: Record<
    string,
    { x: number; y: number; width: number; height: number }
  > = {
    card: { x: 100, y: 200, width: 40, height: 20 },
    column: { x: 300, y: 50, width: 200, height: 600 },
  };
  const getByTestId = vi.fn((id: string) => ({
    hover: vi.fn(async (options: unknown) => {
      calls.push(`hover ${id} ${JSON.stringify(options)}`);
    }),
    boundingBox: vi.fn(async () => boxes[id] ?? null),
  }));
  const page = {
    getByTestId,
    mouse: {
      down: vi.fn(async () => {
        calls.push("down");
      }),
      move: vi.fn(async (x: number, y: number, options: unknown) => {
        calls.push(`move ${String(x)},${String(y)} ${JSON.stringify(options)}`);
      }),
      up: vi.fn(async () => {
        calls.push("up");
      }),
    },
    keyboard: {
      press: vi.fn(async (key: string) => {
        calls.push(`press ${key}`);
      }),
    },
  };
  return { page: page as unknown as Page, calls };
};

it("holds a drag across steps and cancels it with Escape before release", async () => {
  const { page, calls } = dragPage();
  for (const action of dragScenario.actions)
    await performPlaywrightScenarioAction({
      page,
      action,
      secrets: dragSecrets,
    });

  expect(calls).toEqual([
    'hover card {"timeout":500}',
    "down",
    'move 128,210 {"steps":2}',
    'move 310,70 {"steps":3}',
    'move 310,110 {"steps":10}',
    "press Escape",
    "up",
  ]);
});

it("releases a held drag without dropping when the session closes", async () => {
  const { page, calls } = dragPage();
  const start = dragScenario.actions[0];
  if (start === undefined) throw new Error("Expected drag_start action");
  await performPlaywrightScenarioAction({
    page,
    action: start,
    secrets: dragSecrets,
  });

  await expect(releasePlaywrightScenarioDrag(page)).resolves.toBe(true);
  await expect(releasePlaywrightScenarioDrag(page)).resolves.toBe(false);
  expect(calls.slice(-2)).toEqual(["press Escape", "up"]);
});

it("drops at the current point without pressing Escape", async () => {
  const { page, calls } = dragPage();
  const start = dragScenario.actions[0];
  if (start === undefined) throw new Error("Expected drag_start action");
  await performPlaywrightScenarioAction({
    page,
    action: start,
    secrets: dragSecrets,
  });
  await performPlaywrightScenarioAction({
    page,
    action: { step_id: "drop", action: "drag_end", mode: "drop" },
    secrets: dragSecrets,
  });

  expect(calls.at(-1)).toBe("up");
  expect(calls).not.toContain("press Escape");
});

it("rejects a drag move when no drag is held", async () => {
  const { page } = dragPage();
  const move = dragScenario.actions[2];
  if (move === undefined) throw new Error("Expected drag_move action");

  await expect(
    performPlaywrightScenarioAction({
      page,
      action: move,
      secrets: dragSecrets,
    }),
  ).rejects.toThrow("drag_move requires an active drag from drag_start");
});

it("defaults the drag lift threshold and move steps", () => {
  const [start, , nudge] = dragScenario.actions;
  expect(start).toMatchObject({ action: "drag_start", threshold_px: 8 });
  expect(nudge).toMatchObject({ action: "drag_move", steps: 10 });
});

it.each([
  [
    "a move before any drag_start",
    [
      {
        step_id: "move",
        action: "drag_move",
        target: { kind: "delta", x: 1, y: 1 },
      },
    ],
    "drag_move requires an earlier drag_start",
  ],
  [
    "a second drag_start while one is held",
    [
      {
        step_id: "a",
        action: "drag_start",
        locator: { kind: "css", selector: "#a" },
      },
      {
        step_id: "b",
        action: "drag_start",
        locator: { kind: "css", selector: "#b" },
      },
    ],
    "drag_start requires the previous drag to end with drag_end",
  ],
  [
    "an unknown drag_end mode",
    [
      {
        step_id: "a",
        action: "drag_start",
        locator: { kind: "css", selector: "#a" },
      },
      { step_id: "end", action: "drag_end", mode: "throw" },
    ],
    undefined,
  ],
])("rejects %s", (_label, actions, message) => {
  const result = browserScenarioSchema.safeParse({
    browser: { mode: "launch", executable_path: "/opt/chromium" },
    start_url: { url: "https://app.example.test/" },
    actions,
  });
  expect(result.success).toBe(false);
  if (message !== undefined)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      message,
    );
});
