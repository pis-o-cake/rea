import { expect, it } from "vitest";

import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import {
  ACTION_BOUNDARY_GRACE_MS,
  scenarioActionBoundaryMs,
} from "./PlaywrightScenarioActions.js";

const actionTimeoutMs = 40;
const playwrightTimeout = () =>
  new Promise<never>((_, reject) => {
    // Playwright rejects slightly after its own deadline with the call log.
    setTimeout(
      () =>
        reject(
          new Error(
            `locator.click: Timeout ${actionTimeoutMs}ms exceeded.\nCall log:\n  - element intercepts pointer events`,
          ),
        ),
      actionTimeoutMs + 15,
    );
  });

it("keeps the outer action deadline unbounded when the action has none", () => {
  expect(scenarioActionBoundaryMs(undefined)).toBeUndefined();
  expect(scenarioActionBoundaryMs(500)).toBe(500 + ACTION_BOUNDARY_GRACE_MS);
});

it("surfaces Playwright's timeout call log instead of the boundary timeout", async () => {
  await expect(
    withPlaywrightExecutionBoundary(
      playwrightTimeout,
      scenarioActionBoundaryMs(actionTimeoutMs),
    ),
  ).rejects.toThrow(/Call log:\n {2}- element intercepts pointer events/);
});

it("loses the call log when both deadlines are equal", async () => {
  await expect(
    withPlaywrightExecutionBoundary(playwrightTimeout, actionTimeoutMs),
  ).rejects.toThrow(/Analysis operation timed out/);
});
