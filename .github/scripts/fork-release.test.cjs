const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  assertReleaseAssets,
  releaseVersion,
  findUpstreamRelease,
  releaseNotes,
} = require("./fork-release.cjs");

// Actual v0.0.45 release filenames, with the version/channel replaced. Linux
// uses different x64 aliases for AppImage and deb; Windows/macOS use x64.
const version = "0.0.45-nightly.20261005.10";
const assets = [
  `t3-${version}-darwin-arm64.tar.gz`,
  `t3-${version}-linux-arm64.tar.gz`,
  `t3-${version}-linux-x64.tar.gz`,
  `t3-${version}-win32-arm64.zip`,
  `t3-${version}-win32-x64.zip`,
  `T3-Code-${version}-amd64.deb`,
  `T3-Code-${version}-arm64.AppImage`,
  `T3-Code-${version}-arm64.deb`,
  `T3-Code-${version}-arm64.dmg`,
  `T3-Code-${version}-arm64.dmg.blockmap`,
  `T3-Code-${version}-arm64.exe`,
  `T3-Code-${version}-arm64.exe.blockmap`,
  `T3-Code-${version}-arm64.zip`,
  `T3-Code-${version}-arm64.zip.blockmap`,
  `T3-Code-${version}-x64.dmg`,
  `T3-Code-${version}-x64.dmg.blockmap`,
  `T3-Code-${version}-x64.exe`,
  `T3-Code-${version}-x64.exe.blockmap`,
  `T3-Code-${version}-x64.zip`,
  `T3-Code-${version}-x64.zip.blockmap`,
  `T3-Code-${version}-x86_64.AppImage`,
  "nightly-linux-arm64.yml",
  "nightly-linux.yml",
  "nightly-mac.yml",
  "nightly.yml",
  "fork-release.json",
];

test("fork releases advance without changing the upstream package version", () => {
  assert.equal(releaseVersion("0.1.0", "20261005", "10"), "0.1.0-nightly.20261005.10");
  assert.equal(
    releaseVersion("0.1.0-nightly.20261005.4", "20261005", "11"),
    "0.1.0-nightly.20261005.11",
  );
  assert.throws(() => releaseVersion("invalid", "20261005", "11"));
  assert.throws(() => releaseVersion("0.1.0", "20261005", "0"));
});

test("every platform installer, CLI archive, and updater manifest is required", () => {
  assert.doesNotThrow(() => assertReleaseAssets(version, assets));
  for (const missing of assets) {
    assert.throws(
      () =>
        assertReleaseAssets(
          version,
          assets.filter((name) => name !== missing),
        ),
      { message: `Missing release assets: ${missing}` },
    );
  }
  assert.throws(() => assertReleaseAssets("0.1.0-nightly.20261005.11", assets));
});

test("checksum command hashes the final asset bytes and replaces stale checksums", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "t3-fork-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of assets) writeFileSync(join(directory, name), "abc");
  writeFileSync(join(directory, "SHA256SUMS"), "stale checksums");
  execFileSync(process.execPath, [
    join(__dirname, "fork-release.cjs"),
    "checksums",
    directory,
    version,
  ]);
  const expectedDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(
    readFileSync(join(directory, "SHA256SUMS"), "utf8"),
    `${assets
      .toSorted()
      .map((name) => `${expectedDigest}  ${name}`)
      .join("\n")}\n`,
  );
});

test("provenance selects an included upstream release, ignoring fork tags and newer unmerged history", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "t3-fork-provenance-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "upstream");
  const upstream = git("rev-parse", "HEAD");
  git("update-ref", "refs/fork-upstream/tags/v0.0.45-nightly.20261005.1", upstream);
  git("commit", "--allow-empty", "-m", "fork features");
  const fork = git("rev-parse", "HEAD");
  git("tag", "v99.0.0");
  git("update-ref", "refs/fork-upstream/tags/v99.0.0-preview.20261005.1", fork);
  git("checkout", "--detach", upstream);
  git("commit", "--allow-empty", "-m", "not yet integrated");
  git("update-ref", "refs/fork-upstream/tags/v99.0.0", "HEAD");
  const metadata = findUpstreamRelease(cwd, fork);
  assert.deepEqual(metadata, {
    repository: "pingdotgg/t3code",
    tag: "v0.0.45-nightly.20261005.1",
    commit: upstream,
  });
  assert.equal(
    execFileSync(
      process.execPath,
      [join(__dirname, "fork-release.cjs"), "version", "20261006", "20", fork],
      {
        cwd,
        encoding: "utf8",
      },
    ).trim(),
    "0.0.45-nightly.20261006.20",
  );
  const notes = releaseNotes({
    repository: "nitya-ranjan/t3code",
    branch: "nitya/release",
    version,
    commit: fork,
    upstream: metadata,
    buildUrl: "https://github.com/nitya-ranjan/t3code/actions/runs/123",
  });
  assert.ok(notes.includes(upstream));
  assert.ok(notes.includes(fork));
  assert.ok(notes.includes(metadata.tag));
  assert.ok(notes.includes(version));
  assert.match(notes, /install this build manually/);
  const output = join(cwd, "provenance");
  execFileSync(
    process.execPath,
    [join(__dirname, "fork-release.cjs"), "metadata", version, fork, output],
    {
      cwd,
      env: { ...process.env, GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "123" },
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(join(output, "fork-release.json"), "utf8")), {
    schemaVersion: 1,
    repository: "nitya-ranjan/t3code",
    branch: "nitya/release",
    version,
    commit: fork,
    upstream: metadata,
    buildUrl: "https://github.com/nitya-ranjan/t3code/actions/runs/123",
  });
  assert.equal(readFileSync(join(output, "fork-release-notes.md"), "utf8"), notes);
  git("update-ref", "-d", "refs/fork-upstream/tags/v0.0.45-nightly.20261005.1");
  assert.throws(() => findUpstreamRelease(cwd, fork), /No upstream stable\/nightly release/);
});
