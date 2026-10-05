const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const test = require("node:test");
const { prepareCandidate } = require("./fork-sync.cjs");
const { groups, runChecks } = require("./fork-sync-checks.cjs");

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "t3-fork-sync-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=release");
  git("config", "user.name", "Fork Sync Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = (file, text) => {
    writeFileSync(join(cwd, file), text);
    git("add", "--", file);
    git("commit", "-m", text);
    return git("rev-parse", "HEAD");
  };
  const initial = commit("shared.txt", "original\n");
  git("branch", "upstream", initial);
  return {
    cwd,
    git,
    commit,
    initial,
    prepare: () =>
      prepareCandidate({ cwd, baseRef: "refs/heads/release", upstreamRef: "refs/heads/upstream" }),
  };
}

test("merge retains both histories and fork features without moving the release branch", (t) => {
  const f = fixture(t);
  const base = f.commit("fork.txt", "custom feature\n");
  f.git("checkout", "upstream");
  const upstream = f.commit("upstream.txt", "released fix\n");
  const result = f.prepare();
  assert.equal(result.changed, true);
  assert.equal(f.git("rev-parse", "release"), base);
  assert.equal(f.git("show", "-s", "--format=%P", "HEAD"), `${base} ${upstream}`);
  assert.equal(readFileSync(join(f.cwd, "fork.txt"), "utf8"), "custom feature\n");
  assert.equal(readFileSync(join(f.cwd, "upstream.txt"), "utf8"), "released fix\n");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("already integrated upstream does not create a candidate or change checkout", (t) => {
  const f = fixture(t);
  const base = f.commit("fork.txt", "feature\n");
  assert.deepEqual(f.prepare(), { changed: false, base, upstream: f.initial });
  assert.equal(f.git("symbolic-ref", "HEAD"), "refs/heads/release");
});

test("conflicts report affected files and abort cleanly without losing fork commits", (t) => {
  const f = fixture(t);
  const base = f.commit("shared.txt", "fork version\n");
  f.git("checkout", "upstream");
  f.commit("shared.txt", "upstream version\n");
  assert.throws(f.prepare, /Upstream merge conflicts[\s\S]*shared\.txt/);
  assert.equal(f.git("rev-parse", "release"), base);
  assert.equal(f.git("rev-parse", "HEAD"), base);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(f.cwd, "shared.txt"), "utf8"), "fork version\n");
});

test("reruns reuse the published candidate commit exactly", (t) => {
  const f = fixture(t);
  f.commit("fork.txt", "feature\n");
  f.git("checkout", "upstream");
  f.commit("upstream.txt", "fix\n");
  const first = f.prepare();
  f.git("update-ref", `refs/remotes/origin/${first.branch}`, first.sha);
  f.git("checkout", "release");
  assert.deepEqual(f.prepare(), first);
});

test("refuses to replace an existing candidate with unexpected ancestry", (t) => {
  const f = fixture(t);
  f.commit("fork.txt", "feature\n");
  f.git("checkout", "upstream");
  f.commit("upstream.txt", "fix\n");
  const first = f.prepare();
  f.git("update-ref", `refs/remotes/origin/${first.branch}`, f.initial);
  assert.throws(f.prepare, /unexpected parents/);
  assert.equal(f.git("rev-parse", `refs/remotes/origin/${first.branch}`), f.initial);
});

test("a dirty checkout is never overwritten", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "shared.txt"), "uncommitted work\n");
  assert.throws(f.prepare, /clean checkout/);
  assert.equal(readFileSync(join(f.cwd, "shared.txt"), "utf8"), "uncommitted work\n");
});

test("missing fork regression coverage blocks validation before any tests run", (t) => {
  const f = fixture(t);
  let calls = 0;
  const run = () => {
    calls++;
  };
  assert.throws(() => runChecks({ cwd: f.cwd, run }), /Required fork regression tests are missing/);
  assert.equal(calls, 0);
  for (const [directory, , paths] of groups) {
    for (const path of paths) {
      const file = join(f.cwd, directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture");
    }
  }
  runChecks({ cwd: f.cwd, run });
  assert.equal(calls, groups.length);
  rmSync(join(f.cwd, "apps/desktop/src/app/DesktopFleetConnectionsImport.test.ts"));
  assert.throws(() => runChecks({ cwd: f.cwd, run }), /DesktopFleetConnectionsImport\.test\.ts/);
  assert.equal(calls, groups.length);
});
