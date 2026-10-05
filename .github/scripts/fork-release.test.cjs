const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { assertReleaseAssets, releaseVersion } = require("./fork-release.cjs");

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
