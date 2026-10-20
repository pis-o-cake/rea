import type { Locator, Page } from "playwright-core";

import type {
  BrowserScenarioAction,
  BrowserScenarioValue,
} from "../domain/browserScenarioValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";

/**
 * Extra time the outer execution boundary waits beyond an action's own
 * Playwright timeout. With equal deadlines the boundary usually fired first and
 * replaced Playwright's timeout error, whose call log explains why the action
 * could not run (for example another element intercepting pointer events).
 */
export const ACTION_BOUNDARY_GRACE_MS = 2_000;

/** Outer execution deadline for one action; undefined keeps it unbounded. */
export const scenarioActionBoundaryMs = (
  timeoutMs: number | undefined,
): number | undefined =>
  timeoutMs === undefined ? undefined : timeoutMs + ACTION_BOUNDARY_GRACE_MS;

type ScenarioLocator = Extract<
  BrowserScenarioAction,
  { readonly locator: unknown }
>["locator"];

const resolveLocator = (page: Page, locator: ScenarioLocator): Locator => {
  switch (locator.kind) {
    case "test_id":
      return page.getByTestId(locator.value);
    case "role":
      return page.getByRole(locator.role, {
        name: locator.name,
        exact: true,
      });
    case "css":
      return page.locator(locator.selector);
  }
};

const resolveValue = (
  value: BrowserScenarioValue,
  secrets: BrowserScenarioSecrets,
): string => secrets.value(value);

interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

type PointerOffset = Extract<
  BrowserScenarioAction,
  { readonly action: "drag_start" }
>["offset"];

/**
 * Pointer position of a drag whose button is still held, per page. A drag spans
 * several steps so captures can run mid-drag; the session releases any entry
 * left behind by a failed scenario.
 */
const activeDrags = new WeakMap<Page, PointerPoint>();

const locatorPoint = async (
  locator: Locator,
  offset: PointerOffset,
  options: { readonly timeout?: number },
): Promise<PointerPoint> => {
  const box = await locator.boundingBox(options);
  if (box === null) throw new Error("Drag target has no visible box");
  return offset === undefined
    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : { x: box.x + offset.x, y: box.y + offset.y };
};

const heldDrag = (page: Page, action: string): PointerPoint => {
  const point = activeDrags.get(page);
  if (point === undefined)
    throw new Error(`${action} requires an active drag from drag_start`);
  return point;
};

const startDrag = async (
  page: Page,
  action: Extract<BrowserScenarioAction, { readonly action: "drag_start" }>,
  options: { readonly timeout?: number },
): Promise<void> => {
  const locator = resolveLocator(page, action.locator);
  await locator.hover({
    ...options,
    ...(action.offset === undefined ? {} : { position: action.offset }),
  });
  const start = await locatorPoint(locator, action.offset, options);
  await page.mouse.down();
  // Record before moving so a failed lift still releases the held button.
  activeDrags.set(page, start);
  if (action.threshold_px === 0) return;
  const lifted = { x: start.x + action.threshold_px, y: start.y };
  await page.mouse.move(lifted.x, lifted.y, {
    steps: Math.max(1, Math.ceil(action.threshold_px / 4)),
  });
  activeDrags.set(page, lifted);
};

const moveDrag = async (
  page: Page,
  action: Extract<BrowserScenarioAction, { readonly action: "drag_move" }>,
  options: { readonly timeout?: number },
): Promise<void> => {
  const from = heldDrag(page, action.action);
  const { target } = action;
  const to =
    target.kind === "delta"
      ? { x: from.x + target.x, y: from.y + target.y }
      : await locatorPoint(
          resolveLocator(page, target.locator),
          target.offset,
          options,
        );
  await page.mouse.move(to.x, to.y, { steps: action.steps });
  activeDrags.set(page, to);
};

const endDrag = async (page: Page, mode: "drop" | "cancel"): Promise<void> => {
  heldDrag(page, "drag_end");
  activeDrags.delete(page);
  try {
    // Escape aborts native and pointer-driven drags before the button is
    // released, so the release does not drop.
    if (mode === "cancel") await page.keyboard.press("Escape");
  } finally {
    await page.mouse.up();
  }
};

/**
 * Release a drag left held by a failed or truncated scenario without dropping.
 * Returns whether a drag was active.
 */
export const releasePlaywrightScenarioDrag = async (
  page: Page,
): Promise<boolean> => {
  if (!activeDrags.has(page)) return false;
  await endDrag(page, "cancel");
  return true;
};

interface PerformActionInput {
  readonly page: Page;
  readonly action: BrowserScenarioAction;
  readonly secrets: BrowserScenarioSecrets;
}

/** Execute one admitted declarative action with no caller-supplied code. */
export const performPlaywrightScenarioAction = async (
  input: PerformActionInput,
): Promise<void> => {
  const { page, action, secrets } = input;
  const timeout = "timeout_ms" in action ? action.timeout_ms : undefined;
  const options = timeout === undefined ? {} : { timeout };
  switch (action.action) {
    case "goto":
      await page.goto(secrets.url(action.destination), {
        ...options,
        waitUntil: action.wait_until,
      });
      return;
    case "click":
      await resolveLocator(page, action.locator).click({
        ...options,
        button: action.button,
        clickCount: action.click_count,
      });
      return;
    case "fill":
      await resolveLocator(page, action.locator).fill(
        resolveValue(action.value, secrets),
        options,
      );
      return;
    case "press":
      await resolveLocator(page, action.locator).press(action.key, options);
      return;
    case "select_option":
      await resolveLocator(page, action.locator).selectOption(
        resolveValue(action.value, secrets),
        options,
      );
      return;
    case "check":
      await resolveLocator(page, action.locator).check(options);
      return;
    case "uncheck":
      await resolveLocator(page, action.locator).uncheck(options);
      return;
    case "hover":
      await resolveLocator(page, action.locator).hover(options);
      return;
    case "drag_start":
      await startDrag(page, action, options);
      return;
    case "drag_move":
      await moveDrag(page, action, options);
      return;
    case "drag_end":
      await endDrag(page, action.mode);
      return;
    case "wait_for":
      await resolveLocator(page, action.locator).waitFor({
        ...options,
        state: action.state,
      });
      return;
    case "wait_for_timeout":
      await page.waitForTimeout(action.duration_ms);
  }
};
