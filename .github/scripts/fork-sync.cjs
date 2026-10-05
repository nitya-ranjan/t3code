const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasRef(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

// Prepare a detached merge so neither the release branch nor a developer's
// branch moves. Only the workflow's final, successful check step may publish it.
function prepareCandidate({
  cwd,
  baseRef = "refs/remotes/origin/nitya/release",
  upstreamRef = "refs/remotes/upstream/sync",
}) {
  if (git(cwd, ["status", "--porcelain"])) {
    throw new Error("Upstream sync requires a clean checkout.");
  }
  const base = git(cwd, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const upstream = git(cwd, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]);
  if (isAncestor(cwd, upstream, base)) return { changed: false, base, upstream };

  const branch = `fork-sync/${base.slice(0, 12)}-${upstream.slice(0, 12)}`;
  const existing = `refs/remotes/origin/${branch}`;
  if (hasRef(cwd, existing)) {
    const parents = git(cwd, ["show", "-s", "--format=%P", existing]);
    if (parents !== `${base} ${upstream}`) {
      throw new Error(
        `Existing candidate ${branch} has unexpected parents; refusing to replace it.`,
      );
    }
    git(cwd, ["checkout", "--detach", existing]);
    return { changed: true, base, upstream, branch, sha: git(cwd, ["rev-parse", "HEAD"]) };
  }

  git(cwd, ["checkout", "--detach", base]);
  try {
    git(cwd, [
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `chore(fork): merge upstream ${upstream.slice(0, 12)}`,
      upstream,
    ]);
  } catch (cause) {
    const files = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
    if (hasRef(cwd, "MERGE_HEAD")) git(cwd, ["merge", "--abort"]);
    const error = new Error(
      files
        ? `Upstream merge conflicts; nitya/release was not changed. Resolve these files manually:\n${files}`
        : `Upstream merge failed; no candidate was published.\n${cause.stderr || cause.message}`,
      { cause },
    );
    error.syncStatus = files ? "conflict" : "failed";
    throw error;
  }
  return { changed: true, base, upstream, branch, sha: git(cwd, ["rev-parse", "HEAD"]) };
}

if (require.main === module) {
  try {
    const result = prepareCandidate({ cwd: process.cwd() });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(result)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
    }
    const summary = result.changed
      ? `Candidate: \`${result.branch}\`\n\nFork base: \`${result.base}\`\n\nUpstream: \`${result.upstream}\`\n\nMerge: \`${result.sha}\`\n\nThe candidate will be published only after validation. The release branch is unchanged.\n`
      : `The fork already contains upstream \`${result.upstream}\`. No candidate is needed.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary);
  } catch (error) {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `status=${error.syncStatus || "failed"}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Upstream sync failed.\n\n\`\`\`text\n${error.message}\n\`\`\`\n`,
      );
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { prepareCandidate };
