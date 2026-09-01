import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import {
  loadLiveAcceptanceFixture,
  runMcpFacadeLiveAcceptance,
} from "./helpers/mcp-facade-live";

const resource = process.env.TABLOOM_E2E_MCP_RESOURCE_URL;
const fixturePath = process.env.TABLOOM_E2E_MCP_FIXTURE_PATH;
const signingKeyPath = process.env.TABLOOM_E2E_MCP_SIGNING_KEY_PATH;
const liveEnabled = process.env.TABLOOM_E2E_MCP_LIVE === "1" &&
  Boolean(resource) && Boolean(fixturePath) && Boolean(signingKeyPath);

test("two-user live facade acceptance remains an explicit human-auth opt-in", async ({ browser }) => {
  test.skip(
    !liveEnabled,
    "Set the documented data-only live fixture and explicitly opt in to live production acceptance.",
  );
  test.setTimeout(30 * 60 * 1000);

  expect(resource).toBe("https://tabloom-mcp.nickvu.dev");
  const fixture = await loadLiveAcceptanceFixture(fixturePath!, {
    repositoryRoot: resolve("."),
  });
  expect(fixture.resource).toBe(resource);
  await runMcpFacadeLiveAcceptance({
    browser,
    fixture,
    signingKeyPath: signingKeyPath!,
    repositoryRoot: resolve("."),
  });
});
