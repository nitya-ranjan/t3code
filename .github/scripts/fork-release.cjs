const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function releaseVersion(packageVersion, date, runNumber) {
  const base = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(packageVersion)?.[1];
  if (!base || !/^\d{8}$/.test(date) || !/^[1-9]\d*$/.test(runNumber)) {
    throw new Error("Invalid fork release version inputs");
  }
  return `${base}-nightly.${date}.${runNumber}`;
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
  ];
}

function assertReleaseAssets(version, names) {
  const missing = requiredAssets(version).filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Missing release assets: ${missing.join(", ")}`);
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "version") {
    const version = JSON.parse(readFileSync("apps/server/package.json", "utf8")).version;
    console.log(releaseVersion(version, ...args));
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
    throw new Error("Expected version <YYYYMMDD> <run-number> or checksums <directory> <version>");
  }
}

module.exports = { assertReleaseAssets, releaseVersion };
