const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

// These regressions cover the fork's features; package-local Vitest config
// still owns execution, including the server's serialized integration tests.
const groups = [
  ["packages/shared", "@t3tools/shared", ["src/cliRelease.test.ts"]],
  ["packages/contracts", "@t3tools/contracts", ["src/settings.test.ts"]],
  ["packages/client-runtime", "@t3tools/client-runtime", ["src/state/entities.test.ts"]],
  [
    "apps/server",
    "t3",
    [
      "src/cli/update.test.ts",
      "src/project/AgentSessionImporter.test.ts",
      "src/project/AgentSessionScanner.test.ts",
      "src/orchestration-v2/AccountFallbackReactor.test.ts",
      "src/orchestration-v2/accountFallback/handoffPrompt.test.ts",
      "src/orchestration-v2/accountFallback/policy.test.ts",
      "src/orchestration-v2/accountFallback/simulateUsageLimit.test.ts",
      "src/orchestration-v2/accountFallback/webhook.test.ts",
      "src/persistence/Migrations/055_ProjectionThreadsFallback.test.ts",
      "src/persistence/reconcileForkFallbackMigration.test.ts",
      "src/orchestration-v2/legacy/LegacyV1ThreadImporter.test.ts",
    ],
  ],
  [
    "apps/web",
    "@t3tools/web",
    [
      "src/versionSkew.test.ts",
      "src/components/settings/agentSessionImport.logic.test.ts",
      "src/components/chat/fallbackBanner.logic.test.ts",
      "src/components/settings/accountFallbackSettings.logic.test.ts",
    ],
  ],
  [
    "apps/desktop",
    "@t3tools/desktop",
    ["src/app/DesktopFleetConnectionsImport.test.ts", "src/updates/DesktopUpdates.test.ts"],
  ],
  [
    "scripts",
    "@t3tools/scripts",
    ["build-desktop-artifact.test.ts", "install.test.ts", "install-fork.test.ts"],
  ],
];

function runChecks({ cwd = process.cwd(), run = execFileSync } = {}) {
  const missing = groups
    .flatMap(([directory, , paths]) => paths.map((path) => join(directory, path)))
    .filter((path) => !existsSync(join(cwd, path)));
  if (missing.length) {
    throw new Error(
      `Required fork regression tests are missing; restore the feature or update its coverage before promoting:\n${missing.join("\n")}`,
    );
  }
  for (const [, name, paths] of groups) {
    run("vp", ["run", "--filter", name, "test", ...paths], { cwd, stdio: "inherit" });
  }
}

if (require.main === module) runChecks();

module.exports = { groups, runChecks };
