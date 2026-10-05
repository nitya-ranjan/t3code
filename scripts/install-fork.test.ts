// @effect-diagnostics nodeBuiltinImport:off - Runs the public shell installer against isolated local release fixtures.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const installer = NodePath.join(import.meta.dirname, "install-fork.sh");
const version = "0.0.46-nightly.20261005.2";
const commit = "a".repeat(40);
const digest = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

async function fixture(platform = "Darwin") {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-public-install-"));
  const bin = NodePath.join(root, "commands");
  const release = NodePath.join(root, "release");
  const home = NodePath.join(root, "home");
  const stage = NodePath.join(root, "stage");
  const systemApps = NodePath.join(root, "system-applications");
  const fixtureInstaller = NodePath.join(root, "install-fork.sh");
  // Rebase only the system Applications constant; no test may touch a real app.
  await NodeFSP.writeFile(
    fixtureInstaller,
    (await NodeFSP.readFile(installer, "utf8")).replace(
      "system_applications=/Applications",
      `system_applications='${systemApps}'`,
    ),
  );
  await Promise.all([bin, release, home].map((path) => NodeFSP.mkdir(path)));
  const asset =
    platform === "Darwin" ? `T3-Code-${version}-arm64.zip` : `t3-${version}-linux-arm64.tar.gz`;
  const metadata = JSON.stringify({
    repository: "nitya-ranjan/t3code",
    version,
    commit,
    upstream: { repository: "pingdotgg/t3code" },
  });
  await NodeFSP.writeFile(NodePath.join(release, "fork-release.json"), metadata);
  await NodeFSP.writeFile(
    NodePath.join(release, "releases.json"),
    JSON.stringify([
      { tag_name: "v9.0.0-nightly.20261005.9", draft: true },
      { tag_name: "v9.0.0", draft: false },
      { tag_name: `v${version}`, draft: false },
    ]),
  );
  const app = NodePath.join(root, "fixture.app");
  await NodeFSP.mkdir(NodePath.join(app, "Contents"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(app, "Contents/Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: "com.t3tools.t3code",
      CFBundleShortVersionString: version,
    }),
  );
  if (platform === "Linux") {
    const payload = NodePath.join(root, `t3-${version}-linux-arm64`);
    await NodeFSP.mkdir(payload);
    await NodeFSP.writeFile(NodePath.join(payload, "t3"), `#!/bin/sh\nprintf '${version}\\n'\n`, {
      mode: 0o755,
    });
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      NodePath.join(release, asset),
      "-C",
      root,
      NodePath.basename(payload),
    ]);
  } else {
    await NodeFSP.writeFile(NodePath.join(release, asset), "fixture archive");
  }
  async function checksums() {
    const values = await Promise.all(
      ["fork-release.json", asset].map(
        async (file) => `${digest(await NodeFSP.readFile(NodePath.join(release, file)))}  ${file}`,
      ),
    );
    await NodeFSP.writeFile(NodePath.join(release, "SHA256SUMS"), `${values.join("\n")}\n`);
  }
  await checksums();
  const commands: Record<string, string> = {
    uname: 'case "$1" in -s) printf "%s\\n" "$FIX_PLATFORM" ;; -m) echo arm64 ;; esac',
    curl: `http=false
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url=$1 ;; -o) shift; dest=$1 ;; -w) shift; http=true ;; esac
  shift
done
printf '%s\\n' "$url" >> "$FIX_REQUESTS"
case "$url" in
  https://api.github.com/repos/nitya-ranjan/t3code/releases?per_page=100) source="$FIX_RELEASE/releases.json" ;;
  https://github.com/nitya-ranjan/t3code/releases/download/v${version}/*) source="$FIX_RELEASE/$(basename "$url")" ;;
  https://raw.githubusercontent.com/nitya-ranjan/t3code/${commit}/scripts/install.sh) source="$FIX_CLI_INSTALLER" ;;
  *) echo "Unexpected URL: $url" >&2; exit 1 ;;
esac
cp "$source" "$dest"
[ "$http" != true ] || printf 200`,
    unzip: 'printf "T3 Code (Nightly).app/Contents/Info.plist\\n"',
    ditto: `if [ "$1" = -x ]; then
  cp -R "$FIX_APP" "$4/T3 Code (Nightly).app"
else
  cp -R "$1" "$2"
fi`,
    codesign: '[ "${FIX_BAD_SIGNATURE:-false}" != true ]',
    ps: 'printf "%s\\n" "${FIX_PROCESS:-}"',
    mv: `case "$1" in */application.app)
  [ "$FIX_REPLACE_FAILURE" != true ] || exit 1 ;;
esac
exec /bin/mv "$@"`,
  };
  await Promise.all(
    Object.entries(commands).map(([name, source]) =>
      NodeFSP.writeFile(NodePath.join(bin, name), `#!/bin/sh\nset -eu\n${source}\n`, {
        mode: 0o755,
      }),
    ),
  );
  // Model plutil's scalar extraction/insertion without requiring a Mac runner.
  await NodeFSP.writeFile(
    NodePath.join(bin, "plutil"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args.at(-1);
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === '-insert') {
  json[args[1]] = args[3]; fs.writeFileSync(file, JSON.stringify(json));
} else {
  let value = json;
  for (const key of args[1].split('.')) value = value?.[key];
  if (value === undefined) process.exit(1);
  process.stdout.write(String(value));
}
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    GITHUB_ACTIONS: "false",
    T3CODE_HOME: NodePath.join(home, ".t3"),
    T3CODE_INSTALL_BIN_DIR: NodePath.join(home, "bin"),
    T3CODE_VERSION: "",
    T3CODE_FORK_STAGE_DIR: stage,
    FIX_PLATFORM: platform,
    FIX_RELEASE: release,
    FIX_REQUESTS: NodePath.join(root, "requests"),
    FIX_CLI_INSTALLER: NodePath.join(import.meta.dirname, "install.sh"),
    FIX_APP: app,
    FIX_REPLACE_FAILURE: "false",
  };
  return {
    root,
    home,
    stage,
    release,
    asset,
    app,
    bin,
    systemApps,
    checksums,
    run: (args: string[] = [], overrides: Record<string, string> = {}) =>
      NodeChildProcess.spawnSync("sh", [fixtureInstaller, ...args], {
        env: { ...env, ...overrides },
        encoding: "utf8",
      }),
    receipt: async () =>
      JSON.parse(await NodeFSP.readFile(NodePath.join(stage, "status.json"), "utf8")),
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("public fork installer", () => {
  it("defaults to staging a verified published fork nightly and reports status without network", async () => {
    const f = await fixture();
    try {
      if (HostProcessPlatform.defaultValue() === "darwin") {
        await NodeFSP.writeFile(
          NodePath.join(f.bin, "plutil"),
          '#!/bin/sh\nexec /usr/bin/plutil "$@"\n',
        );
      }
      const result = f.run();
      expect(result.stderr, result.stdout).toBe("");
      expect(result.status).toBe(0);
      expect(await f.receipt()).toMatchObject({
        repository: "nitya-ranjan/t3code",
        version,
        status: "staged",
        commit,
        installed_version: "",
        installed_path: "",
      });
      expect(await NodeFSP.readdir(f.home)).toEqual([]);
      const status = f.run(["--status"]);
      expect(JSON.parse(status.stdout)).toEqual(await f.receipt());
      const urls = await NodeFSP.readFile(NodePath.join(f.root, "requests"), "utf8");
      expect(urls).not.toContain("pingdotgg");
      expect(urls.split("api.github.com")).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  });

  it("forces Actions to stage even if installation was requested", async () => {
    const f = await fixture();
    try {
      expect(f.run(["--install", "--version", version], { GITHUB_ACTIONS: "true" }).status).toBe(0);
      expect((await f.receipt()).status).toBe("staged");
      expect(await NodeFSP.readdir(f.home)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it.each(["Nightly", "Alpha"])(
    "reports the older installed %s version while only staging the new release",
    async (channel) => {
      const f = await fixture();
      try {
        await NodeFSP.mkdir(f.systemApps);
        const oldApp = NodePath.join(f.systemApps, `T3 Code (${channel}).app`);
        await NodeFSP.cp(f.app, oldApp, { recursive: true });
        const infoPath = NodePath.join(oldApp, "Contents/Info.plist");
        const oldInfo = JSON.stringify({
          CFBundleIdentifier: "com.t3tools.t3code",
          CFBundleShortVersionString: "0.0.44-preview.20260930.3",
        });
        await NodeFSP.writeFile(infoPath, oldInfo);
        const result = f.run(["--stage", "--version", version]);
        expect(result.status, result.stderr).toBe(0);
        expect(await f.receipt()).toMatchObject({
          version,
          status: "staged",
          target: NodePath.join(f.systemApps, "T3 Code (Nightly).app"),
          installed_version: "0.0.44-preview.20260930.3",
          installed_path: oldApp,
        });
        expect(await NodeFSP.readFile(infoPath, "utf8")).toBe(oldInfo);
        expect(result.stdout).toContain("running server version is not checked");
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each([
    { systemNightly: true, userNightly: true, systemAlpha: true, expected: "system" },
    { systemNightly: false, userNightly: true, systemAlpha: true, expected: "user" },
    { systemNightly: false, userNightly: false, systemAlpha: true, expected: "system" },
    { systemNightly: false, userNightly: false, systemAlpha: false, expected: "user" },
  ])(
    "keeps the existing Mac installation location: $systemNightly/$userNightly/$systemAlpha",
    async (locations) => {
      const f = await fixture();
      try {
        const userApps = NodePath.join(f.home, "Applications");
        await NodeFSP.mkdir(userApps);
        await NodeFSP.mkdir(f.systemApps);
        for (const [present, path] of [
          [locations.systemNightly, NodePath.join(f.systemApps, "T3 Code (Nightly).app")],
          [locations.userNightly, NodePath.join(userApps, "T3 Code (Nightly).app")],
          [locations.systemAlpha, NodePath.join(f.systemApps, "T3 Code (Alpha).app")],
        ] as const) {
          if (present) await NodeFSP.cp(f.app, path, { recursive: true });
        }
        const result = f.run(["--version", version]);
        expect(result.status, result.stderr).toBe(0);
        expect((await f.receipt()).target).toBe(
          NodePath.join(
            locations.expected === "system" ? f.systemApps : userApps,
            "T3 Code (Nightly).app",
          ),
        );
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each(["checksum", "repository", "version", "signature"])(
    "refuses invalid %s before changing an installation",
    async (failure) => {
      const f = await fixture();
      try {
        if (failure === "checksum")
          await NodeFSP.appendFile(NodePath.join(f.release, f.asset), "corrupt");
        if (failure === "repository" || failure === "version") {
          await NodeFSP.writeFile(
            NodePath.join(f.release, "fork-release.json"),
            JSON.stringify({
              repository: failure === "repository" ? "pingdotgg/t3code" : "nitya-ranjan/t3code",
              version: failure === "version" ? "1.2.3" : version,
              commit,
            }),
          );
          await f.checksums();
        }
        expect(
          f.run(["--install", "--version", version], {
            FIX_BAD_SIGNATURE: String(failure === "signature"),
          }).status,
        ).not.toBe(0);
        expect(await NodeFSP.readdir(f.home)).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
  );

  it("refuses a running Mac app, then installs the cached archive and retains the previous app", async () => {
    const f = await fixture();
    try {
      const target = NodePath.join(f.home, "Applications/T3 Code (Nightly).app");
      await NodeFSP.mkdir(NodePath.dirname(target));
      await NodeFSP.cp(f.app, target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, "old-build"), "old");
      expect(
        f.run(["--install", "--version", version], {
          FIX_PROCESS: `${target}/Contents/MacOS/T3 Code (Nightly)`,
        }).status,
      ).toBe(1);
      expect(await NodeFSP.readFile(NodePath.join(target, "old-build"), "utf8")).toBe("old");
      const requestsBefore = await NodeFSP.readFile(NodePath.join(f.root, "requests"), "utf8");
      const result = f.run(["--install", "--version", version]);
      expect(result.status, result.stderr).toBe(0);
      const receipt = await f.receipt();
      expect(receipt.status).toBe("installed");
      expect(receipt.installed_version).toBe(version);
      expect(receipt.installed_path).toBe(target);
      expect(await NodeFSP.readFile(NodePath.join(receipt.previous_app, "old-build"), "utf8")).toBe(
        "old",
      );
      expect(await NodeFSP.readFile(NodePath.join(f.root, "requests"), "utf8")).toBe(
        requestsBefore,
      );
    } finally {
      await f.cleanup();
    }
  });

  it("restores the previous app if replacement fails", async () => {
    const f = await fixture();
    try {
      const target = NodePath.join(f.home, "old.app");
      await NodeFSP.cp(f.app, target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, "old-build"), "old");
      const result = f.run(["--install", "--version", version, "--target", target], {
        FIX_REPLACE_FAILURE: "true",
      });
      expect(result.status).toBe(1);
      expect(await NodeFSP.readFile(NodePath.join(target, "old-build"), "utf8")).toBe("old");
    } finally {
      await f.cleanup();
    }
  });

  it("moves both old Alpha apps and the replaced app to distinct Trash paths without touching settings", async () => {
    const f = await fixture();
    try {
      const userApps = NodePath.join(f.home, "Applications");
      await NodeFSP.mkdir(userApps);
      await NodeFSP.mkdir(f.systemApps);
      for (const dir of [userApps, f.systemApps]) {
        await NodeFSP.cp(f.app, NodePath.join(dir, "T3 Code (Alpha).app"), { recursive: true });
      }
      await NodeFSP.cp(f.app, NodePath.join(userApps, "T3 Code (Nightly).app"), {
        recursive: true,
      });
      const userdata = NodePath.join(f.home, ".t3/userdata");
      await NodeFSP.mkdir(userdata, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(userdata, "settings.json"), "preserve-me");
      const result = f.run(["--install", "--cleanup-old-apps", "--version", version]);
      expect(result.status, result.stderr).toBe(0);
      expect(await NodeFSP.readdir(NodePath.join(f.home, ".Trash"))).toHaveLength(3);
      expect(await NodeFSP.readdir(f.systemApps)).toEqual([]);
      expect(await NodeFSP.readdir(userApps)).toEqual(["T3 Code (Nightly).app"]);
      expect(await NodeFSP.readFile(NodePath.join(userdata, "settings.json"), "utf8")).toBe(
        "preserve-me",
      );
      expect((await f.receipt()).cleanup_status).toBe("completed");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects old-app cleanup during Actions staging", async () => {
    const f = await fixture();
    try {
      const result = f.run(["--install", "--cleanup-old-apps"], { GITHUB_ACTIONS: "true" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("never GitHub Actions");
      expect(await NodeFSP.readdir(f.home)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("stages Linux through the commit-pinned CLI installer without touching the active T3 home", async () => {
    const f = await fixture("Linux");
    try {
      const result = f.run(["--version", version]);
      expect(result.status, result.stderr).toBe(0);
      const receipt = await f.receipt();
      expect(receipt.status).toBe("staged");
      expect(
        await NodeFSP.readFile(NodePath.join(receipt.staged_path, ".install-complete"), "utf8"),
      ).toBe(`${version}\n`);
      expect(await NodeFSP.readdir(f.home)).toEqual([]);
      expect(await NodeFSP.readFile(NodePath.join(f.root, "requests"), "utf8")).toContain(
        `/${commit}/scripts/install.sh`,
      );
    } finally {
      await f.cleanup();
    }
  });

  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
    "promotes Linux to a final runtime path and refuses an active installed runtime",
    async () => {
      const f = await fixture("Linux");
      try {
        const result = f.run(["--install", "--version", version]);
        expect(result.status, result.stderr).toBe(0);
        const target = NodePath.join(f.home, "bin/t3");
        const runtime = NodePath.join(f.home, `.t3/runtime/versions/${version}/t3`);
        expect(await NodeFSP.readlink(target)).toBe(runtime);
        expect(
          NodeChildProcess.execFileSync(target, ["--version"], { encoding: "utf8" }).trim(),
        ).toBe(version);
        await NodeFSP.writeFile(
          NodePath.join(f.bin, "readlink"),
          `#!/bin/sh\ncase "$1" in /proc/*) printf '%s\\n' '${runtime}' ;; *) exec /usr/bin/readlink "$@" ;; esac\n`,
          { mode: 0o755 },
        );
        const busy = f.run(["--install", "--version", version]);
        expect(busy.status).toBe(1);
        expect(busy.stderr).toContain("installed CLI is running");
        expect(await NodeFSP.readlink(target)).toBe(runtime);
      } finally {
        await f.cleanup();
      }
    },
  );
});
