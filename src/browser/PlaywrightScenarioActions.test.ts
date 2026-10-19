import { expect, it, vi } from "vitest";
import type { Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";

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
