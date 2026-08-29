import { expect, test } from "@playwright/test";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_ENVIRONMENT = [
  "TABLOOM_E2E_MCP_RESOURCE_URL",
  "TABLOOM_E2E_MCP_FIXTURE_MODULE",
  "TABLOOM_E2E_MCP_USER_A",
  "TABLOOM_E2E_MCP_USER_B",
] as const;
const liveEnabled =
  process.env.TABLOOM_E2E_MCP_LIVE === "1" &&
  REQUIRED_ENVIRONMENT.every((name) => Boolean(process.env[name]));

type Claims = {
  issuer: string;
  resource: string;
  algorithm: string;
  audience: readonly string[];
  scope: string;
};

type LiveUserSession = {
  claims(): Promise<Claims>;
  serviceStatus(): Promise<"success" | "unauthorized">;
  refreshOnce(): Promise<{
    rotated: boolean;
    previousRefreshRejected: boolean;
  }>;
  revoke(): Promise<"success">;
  serviceStatusAfterRevocation(): Promise<"unauthorized">;
};

type LiveFixture = {
  authorize(label: string): Promise<LiveUserSession>;
  nestedSubjectMismatchRejected(
    userA: LiveUserSession,
    userB: LiveUserSession,
  ): Promise<boolean>;
  crossUserWorkspaceAccessRejected(
    userA: LiveUserSession,
    userB: LiveUserSession,
  ): Promise<boolean>;
};

type FixtureModule = {
  createMcpFacadeLiveFixture(options: {
    resource: string;
  }): Promise<LiveFixture>;
};

async function secretSafeStep<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw new Error("A secret-safe live facade acceptance step failed");
  }
}

function expectExactClaims(claims: Claims, resource: string) {
  expect(claims.issuer === resource).toBe(true);
  expect(claims.resource === resource).toBe(true);
  expect(claims.algorithm === "ES256").toBe(true);
  expect(
    claims.audience.length === 1 && claims.audience[0] === resource,
  ).toBe(true);
  expect(claims.scope === "tabloom:workspace").toBe(true);
}

function isInsideRepository(path: string) {
  const fromRoot = relative(resolve("."), resolve(path));
  return fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..");
}

test("two-user live facade acceptance remains an explicit human-auth opt-in", async () => {
  test.skip(
    !liveEnabled,
    "Set every documented TABLOOM_E2E_MCP_* value and explicitly opt in to live production acceptance.",
  );
  test.setTimeout(30 * 60 * 1000);

  const resource = process.env.TABLOOM_E2E_MCP_RESOURCE_URL!;
  const fixturePath = process.env.TABLOOM_E2E_MCP_FIXTURE_MODULE!;
  expect(resource).toBe("https://tabloom-mcp.vercel.app");
  expect(isAbsolute(fixturePath)).toBe(true);
  expect(isInsideRepository(fixturePath)).toBe(false);

  const fixtureModule = await secretSafeStep(
    () => import(pathToFileURL(fixturePath).href) as Promise<FixtureModule>,
  );
  const fixture = await secretSafeStep(
    () => fixtureModule.createMcpFacadeLiveFixture({ resource }),
  );
  const userA = await secretSafeStep(
    () => fixture.authorize(process.env.TABLOOM_E2E_MCP_USER_A!),
  );
  const userB = await secretSafeStep(
    () => fixture.authorize(process.env.TABLOOM_E2E_MCP_USER_B!),
  );

  expectExactClaims(await secretSafeStep(() => userA.claims()), resource);
  expectExactClaims(await secretSafeStep(() => userB.claims()), resource);
  expect(
    await secretSafeStep(() => userA.serviceStatus()) === "success",
  ).toBe(true);
  expect(
    await secretSafeStep(() => userB.serviceStatus()) === "success",
  ).toBe(true);
  expect(
    await secretSafeStep(
      () => fixture.nestedSubjectMismatchRejected(userA, userB),
    ),
  ).toBe(true);
  expect(
    await secretSafeStep(
      () => fixture.crossUserWorkspaceAccessRejected(userA, userB),
    ),
  ).toBe(true);

  for (const session of [userA, userB]) {
    const refresh = await secretSafeStep(() => session.refreshOnce());
    expect(refresh.rotated === true).toBe(true);
    expect(refresh.previousRefreshRejected === true).toBe(true);
    expect(
      await secretSafeStep(() => session.revoke()) === "success",
    ).toBe(true);
    expect(
      await secretSafeStep(() => session.serviceStatusAfterRevocation()) ===
        "unauthorized",
    ).toBe(true);
  }
});
