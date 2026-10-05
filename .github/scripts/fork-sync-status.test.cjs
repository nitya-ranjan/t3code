const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  replaceStatus,
  statusText,
  releaseStatusText,
  updateMaintenanceIssue,
  updateReleaseMaintenanceIssue,
} = require("./fork-sync-status.cjs");

test("status refresh preserves the human checklist and never appends duplicate sections", () => {
  const checklist = "# Fork maintenance\n\n- [ ] Migrate custom features\n- [x] Set up tracking\n";
  const first = replaceStatus(checklist, "Merge conflicts");
  const next = replaceStatus(first + "\nMaintainer notes\n", "Candidate ready");
  assert.ok(next.startsWith(checklist));
  assert.ok(next.endsWith("\nMaintainer notes\n"));
  assert.equal(next.split("<!-- fork-sync-status:start -->").length, 2);
  assert.ok(!next.includes("Merge conflicts"));
  assert.ok(next.includes("Candidate ready"));
  assert.equal(replaceStatus(next, "Candidate ready"), next);
  assert.throws(
    () => replaceStatus("Human text\n<!-- fork-sync-status:start -->", "new"),
    /invalid status markers/,
  );
});

test("reports conflict, failed checks, checked drift, and integrated upstream separately", () => {
  assert.match(statusText({ JOB_STATUS: "failure", SYNC_STATUS: "conflict" }), /merge conflicts/);
  assert.match(statusText({ JOB_STATUS: "failure", SYNC_CHANGED: "true" }), /Sync failed/);
  assert.match(
    statusText({ JOB_STATUS: "success", SYNC_CHANGED: "true", PUBLISH_OUTCOME: "success" }),
    /ready for review/,
  );
  assert.match(statusText({ JOB_STATUS: "success", SYNC_CHANGED: "false" }), /Up to date/);
});

test("missing issue configuration writes only the summary; configured updates edit one issue body", async () => {
  const calls = [];
  const core = {
    summary: {
      addRaw: (text) => {
        calls.push(["summary", text]);
        return { write: async () => {} };
      },
    },
    info: () => {},
  };
  const github = {
    rest: {
      issues: {
        get: async (input) => {
          calls.push(["get", input]);
          return { data: { body: "Human checklist" } };
        },
        update: async (input) => calls.push(["update", input]),
      },
    },
  };
  const context = { repo: { owner: "nitya-ranjan", repo: "t3code" } };
  await updateMaintenanceIssue({
    github,
    context,
    core,
    env: { JOB_STATUS: "success", SYNC_CHANGED: "false" },
  });
  assert.equal(calls.length, 1);
  await updateMaintenanceIssue({
    github,
    context,
    core,
    env: { JOB_STATUS: "success", SYNC_CHANGED: "false", FORK_MAINTENANCE_ISSUE: "1" },
  });
  assert.deepEqual(calls[2], ["get", { owner: "nitya-ranjan", repo: "t3code", issue_number: 1 }]);
  assert.equal(calls[3][0], "update");
  assert.equal(calls[3][1].issue_number, 1);
  assert.ok(calls[3][1].body.startsWith("Human checklist"));
});

test("release results preserve the sync section and manual checklist and link only published builds", async () => {
  const original = replaceStatus("- [ ] Verify my Macs\n", "Upstream sync is current");
  let body = original;
  const github = {
    rest: {
      issues: {
        get: async () => ({ data: { body } }),
        update: async (input) => {
          body = input.body;
        },
      },
    },
  };
  const core = { summary: { addRaw: () => ({ write: async () => {} }) }, info: () => {} };
  const context = { repo: { owner: "nitya-ranjan", repo: "t3code" } };
  const env = {
    FORK_MAINTENANCE_ISSUE: "1",
    RELEASE_RESULT: "success",
    RELEASE_VERSION: "0.0.46-nightly.20261005.3",
    RELEASE_COMMIT: "abc123",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "nitya-ranjan/t3code",
    GITHUB_RUN_ID: "123",
  };
  await updateReleaseMaintenanceIssue({ github, context, core, env });
  assert.ok(body.startsWith(original));
  assert.match(body, /releases\/tag\/v0\.0\.46-nightly\.20261005\.3/);
  assert.match(body, /Fork commit: `abc123`/);
  assert.match(body, /actions\/runs\/123/);
  assert.match(body, /macOS installation remains manual/);
  await updateReleaseMaintenanceIssue({
    github,
    context,
    core,
    env: { ...env, RELEASE_RESULT: "failure" },
  });
  assert.ok(body.startsWith(original));
  assert.match(body, /failed or a prerequisite was skipped/);
  assert.doesNotMatch(body, /Published release/);
  assert.equal(body.split("<!-- fork-release-status:start -->").length, 2);
  const syncRefresh = replaceStatus(body, "New upstream drift");
  assert.ok(syncRefresh.includes(releaseStatusText({ ...env, RELEASE_RESULT: "failure" })));
  assert.match(
    releaseStatusText({ ...env, RELEASE_RESULT: "cancelled", RELEASE_VERSION: "" }),
    /Version: not resolved/,
  );
});

test("release tracker refuses to edit a pull request", async () => {
  let wrote = false;
  await assert.rejects(
    () =>
      updateReleaseMaintenanceIssue({
        github: {
          rest: {
            issues: {
              get: async () => ({
                data: {
                  body: "PR description",
                  pull_request: { url: "https://example.invalid/pr/1" },
                },
              }),
              update: async () => {
                wrote = true;
              },
            },
          },
        },
        context: { repo: { owner: "nitya-ranjan", repo: "t3code" } },
        core: { summary: { addRaw: () => ({ write: async () => {} }) }, info: () => {} },
        env: { FORK_MAINTENANCE_ISSUE: "1", RELEASE_RESULT: "failure" },
      }),
    /not a pull request/,
  );
  assert.equal(wrote, false);
});
