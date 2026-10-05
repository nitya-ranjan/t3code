const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function releaseVersion(packageVersion, date, runNumber) {
  const base = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(packageVersion)?.[1];
  if (!base || !/^\d{8}$/.test(date) || !/^[1-9]\d*$/.test(runNumber)) {
    throw new Error("Invalid fork release version inputs");
  }
  return `${base}-nightly.${date}.${runNumber}`;
}

// Upstream refs have their own namespace so a fork tag can never be mistaken
// for the upstream source. Only release tags already contained in the build
// count; a newer unmerged release must not appear in its provenance.
function findUpstreamRelease(cwd, commit) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const prefix = "refs/fork-upstream/tags/";
  const refs = git(
    "for-each-ref",
    "--sort=-version:refname",
    "--sort=-creatordate",
    "--format=%(refname)",
    prefix,
  ).split("\n");
  for (const ref of refs) {
    const tag = ref.slice(prefix.length);
    if (!/^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(tag)) continue;
    const upstreamCommit = git("rev-parse", `${ref}^{commit}`);
    try {
      git("merge-base", "--is-ancestor", upstreamCommit, commit);
      return { repository: "pingdotgg/t3code", tag, commit: upstreamCommit };
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  throw new Error("No upstream stable/nightly release is an ancestor of the selected fork commit.");
}

function releaseNotes(metadata) {
  return (
    `Fork ${metadata.version}\n\n` +
    `Built from [${metadata.repository}@${metadata.commit}](https://github.com/${metadata.repository}/commit/${metadata.commit}) on \`${metadata.branch}\`.\n\n` +
    `Includes upstream [${metadata.upstream.tag}](https://github.com/${metadata.upstream.repository}/releases/tag/${metadata.upstream.tag}) at \`${metadata.upstream.commit}\`.\n\n` +
    `Build: ${metadata.buildUrl}\n\n` +
    "Source details are attached as `fork-release.json` and covered by `SHA256SUMS`.\n\n" +
    "macOS: install this build manually. This fork currently has no Apple Developer ID signing credentials; automatic installation is not supported.\n\n" +
    "This release uses the V2 database. Keep a backup of existing data before first launch; do not run an older build against an upgraded database.\n\n" +
    "Desktop and CLI updates come from nitya-ranjan/t3code. Mobile apps and T3 Connect infrastructure are not published by this workflow.\n"
  );
}

function requiredAssets(version) {
  return [
    ...["darwin", "linux", "win32"].flatMap((platform) =>
      // Node single-executables are unsupported on Intel macOS.
      (platform === "darwin" ? ["arm64"] : ["arm64", "x64"]).map(
        (arch) => `t3-${version}-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`,
      ),
    ),
    ...["arm64", "x64"].flatMap((arch) =>
      ["dmg", "zip", "exe", "dmg.blockmap", "zip.blockmap", "exe.blockmap"].map(
        (extension) => `T3-Code-${version}-${arch}.${extension}`,
      ),
    ),
    `T3-Code-${version}-arm64.AppImage`,
    `T3-Code-${version}-x86_64.AppImage`,
    `T3-Code-${version}-arm64.deb`,
    `T3-Code-${version}-amd64.deb`,
    "nightly.yml",
    "nightly-mac.yml",
    "nightly-linux.yml",
    "nightly-linux-arm64.yml",
    "fork-release.json",
  ];
}

function assertReleaseAssets(version, names) {
  const missing = requiredAssets(version).filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Missing release assets: ${missing.join(", ")}`);
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "version") {
    const [date, runNumber, commit] = args;
    const version = commit
      ? findUpstreamRelease(process.cwd(), commit).tag.slice(1)
      : JSON.parse(readFileSync("apps/server/package.json", "utf8")).version;
    console.log(releaseVersion(version, date, runNumber));
  } else if (command === "metadata") {
    const [version, commit, directory] = args;
    const metadata = {
      schemaVersion: 1,
      repository: "nitya-ranjan/t3code",
      branch: "nitya/release",
      version,
      commit,
      upstream: findUpstreamRelease(process.cwd(), commit),
      buildUrl: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/nitya-ranjan/t3code/actions/runs/${process.env.GITHUB_RUN_ID}`,
    };
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "fork-release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(join(directory, "fork-release-notes.md"), releaseNotes(metadata));
  } else if (command === "checksums") {
    const [directory, version] = args;
    const names = readdirSync(directory)
      .filter((name) => name !== "SHA256SUMS")
      .sort();
    assertReleaseAssets(version, names);
    const checksums = names.map((name) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex");
      return `${digest}  ${name}`;
    });
    writeFileSync(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  } else {
    throw new Error(
      "Expected version <YYYYMMDD> <run-number> [commit], metadata <version> <commit> <directory>, or checksums <directory> <version>",
    );
  }
}

module.exports = { assertReleaseAssets, releaseVersion, findUpstreamRelease, releaseNotes };
