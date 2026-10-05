function replaceStatus(body, status, marker = "fork-sync-status") {
  const START = `<!-- ${marker}:start -->`;
  const END = `<!-- ${marker}:end -->`;
  const block = `${START}\n${status.trim()}\n${END}`;
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start === -1 && end === -1) return `${body.trimEnd()}\n\n${block}\n`;
  if (
    start === -1 ||
    end < start ||
    body.indexOf(START, start + START.length) !== -1 ||
    body.indexOf(END, end + END.length) !== -1
  ) {
    throw new Error("Maintenance issue has invalid status markers; refusing to change its body.");
  }
  return body.slice(0, start) + block + body.slice(end + END.length);
}

function statusText(env) {
  let status;
  if (env.JOB_STATUS === "cancelled") status = "Sync cancelled; release branch unchanged.";
  else if (env.SYNC_STATUS === "conflict")
    status = "Upstream drift: merge conflicts need resolution. Release branch unchanged.";
  else if (env.JOB_STATUS !== "success")
    status = "Sync failed; inspect the run before promoting anything. Release branch unchanged.";
  else if (env.SYNC_CHANGED === "false")
    status = "Up to date: the release branch already includes this upstream release.";
  else if (env.PUBLISH_OUTCOME === "success")
    status = "Upstream drift: candidate passed checks and is ready for review and promotion.";
  else status = "Upstream drift: candidate has not been published. Release branch unchanged.";
  const lines = ["### Automated upstream sync status", "", status, ""];
  if (env.UPSTREAM_REF) lines.push(`Upstream ref: \`${env.UPSTREAM_REF}\``);
  if (env.UPSTREAM_SHA) lines.push(`Upstream commit: \`${env.UPSTREAM_SHA}\``);
  if (env.BASE_SHA) lines.push(`Fork release commit: \`${env.BASE_SHA}\``);
  if (env.CANDIDATE_SHA)
    lines.push(`Candidate: \`${env.CANDIDATE_BRANCH}\` at \`${env.CANDIDATE_SHA}\``);
  lines.push(
    "",
    `[Workflow run](${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID})`,
  );
  return lines.join("\n");
}

function releaseStatusText(env) {
  const published = env.RELEASE_RESULT === "success";
  const status = published
    ? "Fork release published. macOS installation remains manual."
    : env.RELEASE_RESULT === "cancelled"
      ? "Fork release cancelled; no published build was confirmed."
      : "Fork release failed or a prerequisite was skipped; no published build was confirmed.";
  const origin = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
  const lines = ["### Automated fork release status", "", status, ""];
  lines.push(`Version: ${env.RELEASE_VERSION ? `\`${env.RELEASE_VERSION}\`` : "not resolved"}`);
  lines.push(`Fork commit: \`${env.RELEASE_COMMIT}\``);
  lines.push("", `[Build run](${origin}/actions/runs/${env.GITHUB_RUN_ID})`);
  if (published && env.RELEASE_VERSION) {
    lines.push(`[Published release](${origin}/releases/tag/v${env.RELEASE_VERSION})`);
  }
  return lines.join("\n");
}

async function updateIssueStatus({ github, context, core, env, status, marker }) {
  await core.summary.addRaw(`${status}\n`).write();
  const issueNumber = env.FORK_MAINTENANCE_ISSUE?.trim();
  if (!issueNumber) {
    core.info("FORK_MAINTENANCE_ISSUE is unset; status is available in the run summary.");
    return;
  }
  if (!/^[1-9]\d*$/.test(issueNumber))
    throw new Error("FORK_MAINTENANCE_ISSUE must be an issue number.");
  const issue = { ...context.repo, issue_number: Number(issueNumber) };
  const { data } = await github.rest.issues.get(issue);
  if (data.pull_request)
    throw new Error("FORK_MAINTENANCE_ISSUE must refer to an issue, not a pull request.");
  const body = replaceStatus(data.body || "", status, marker);
  if (body !== data.body) await github.rest.issues.update({ ...issue, body });
}

async function updateMaintenanceIssue({ env = process.env, ...options }) {
  await updateIssueStatus({ ...options, env, status: statusText(env), marker: "fork-sync-status" });
}

async function updateReleaseMaintenanceIssue({ env = process.env, ...options }) {
  await updateIssueStatus({
    ...options,
    env,
    status: releaseStatusText(env),
    marker: "fork-release-status",
  });
}

module.exports = {
  replaceStatus,
  statusText,
  releaseStatusText,
  updateMaintenanceIssue,
  updateReleaseMaintenanceIssue,
};
