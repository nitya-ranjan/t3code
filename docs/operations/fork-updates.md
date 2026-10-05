# Maintaining this fork

`nitya/release` combines the fork's account fallback, session import, and fleet
connection features. Keep it as the integration branch. Merge upstream into it;
resetting it to upstream would discard those features.

## Enable the workflows

Land this setup on `nitya/release` and on the fork's default branch (`main`).
GitHub only schedules workflows from the default branch, and manually dispatched
workflows must also exist there. Keep GitHub Actions enabled. The fork workflows
use GitHub-hosted runners; upstream's Blacksmith runners, npm publishing, and
hosted-app deployment are not required.

For syncs that modify workflow files, configure a `FORK_SYNC_TOKEN` Actions secret
with access only to this fork and **Contents: write** plus **Workflows: write**.
The default GitHub token cannot grant workflow-writing permission. Without this
secret, ordinary candidate pushes can work, but GitHub can reject candidates that
update `.github/workflows`; the run reports the failure. Release publishing uses
the built-in GitHub token. Put tokens in GitHub's secret settings, never in source.

The upstream Release workflow is restricted to `pingdotgg/t3code`.
Use **Prepare fork upstream sync** and **Release fork** in this repository.
Custom mobile publishing is deferred; do not configure or dispatch the inherited
Mobile EAS workflows for this fork.

## Bring in upstream changes

**Prepare fork upstream sync** checks every six hours for the latest published
upstream nightly/beta release. Run it manually to check sooner. The optional
`upstream_ref` accepts a tag or branch: choose a stable tag such as `v0.0.45` to
test that release, or `main` to test unpublished upstream changes. The default
excludes the maintainers' separate preview train.

The workflow merges into a detached candidate, runs typechecks, the fork feature
regressions, and a desktop/server/web build, then publishes a `fork-sync/...`
branch. It never resets `nitya/release`, opens a pull request, or publishes an app
release. Missing feature tests fail the checks instead of being silently skipped.

Set the Actions repository variable `FORK_MAINTENANCE_ISSUE` to `1` to track results
in the [fork maintenance issue](https://github.com/nitya-ranjan/t3code/issues/1).
Each run replaces the issue's marked status section with the selected upstream
ref and commit, fork commit, candidate when available, and a link to its checks.
Conflicts and failed checks leave the release branch unchanged. The issue's
manual checklist and notes are preserved; automation creates no issues or
comments. The built-in GitHub token needs **Issues: write**, already declared by
the workflow. With the variable unset, results stay in the run summary.
The release workflow maintains a separate marked section in the same issue with
its latest outcome, version, exact fork commit, and build run. Successful runs link
the published release; failed or skipped builds are recorded without a release
link. Updating either section preserves the other section and the manual checklist.

Review the successful run's exact candidate SHA and diff. From a clean checkout
of `nitya/release`, promote that commit:

```sh
git fetch origin
git merge --ff-only origin/nitya/release
git merge --ff-only <tested-candidate-sha>
git push origin HEAD:nitya/release
```

If either fast-forward fails, rerun sync against the newer release branch; do not
force-push. Conflicts appear in the run summary and leave the release branch
unchanged. Resolve them in a separate working branch with an ordinary merge,
review the feature behavior, and run the same checks before promotion. Git cannot
guarantee that a clean merge preserves behavior; these regression checks are the
release gate, not a substitute for reviewing changed features.

## Publish a fork build

Dispatch **Release fork**, selecting `nitya/release`. It builds that exact commit,
runs the fork regression checks, and publishes a GitHub prerelease after every
platform succeeds. Versions use `<upstream-version>-nightly.<date>.<run-number>`
so multiple fork releases between upstream versions remain distinguishable.
The name `nightly` selects the existing updater channel; publishing is manual.

The release notes and attached `fork-release.json` record the exact fork commit,
version, latest included upstream stable/nightly tag and commit, and build run.
The upstream tag is selected from the fork commit's ancestors, so a newer release
that has not been merged is never claimed as included. `SHA256SUMS` covers the
metadata and all downloadable assets. All assets are uploaded to a draft and
verified before the release becomes visible to update clients. The shared bundle
passes its desktop preload smoke check; each CLI archive is smoke-tested on its
native platform by the packaging workflow.

The release contains macOS, Windows, and Linux desktop installers for ARM64 and
x64, updater manifests, blockmaps, CLI archives, and `SHA256SUMS`. Standalone CLI
archives cover macOS ARM64, Linux ARM64/x64, and Windows ARM64/x64; macOS x64 uses
the desktop's bundled server. No npm package or public hosted web app is published.
The fork's web client ships inside the desktop and server builds. Connect to that
server's web origin to use fork UI features; `app.t3.codes` serves upstream's UI.

Desktop and CLI update discovery and downloads default to
`nitya-ranjan/t3code`. An explicit build-time desktop repository override or CLI
download mirror still takes precedence. Avoid pointing these overrides at
upstream when distributing this fork. The build does not configure a private
T3 Connect deployment; direct and Tailscale connections use the existing server
paths.

This fork currently has no Apple Developer ID. macOS builds are unsigned/ad-hoc:
download and install each new fork release manually. Updater metadata does not
make automatic macOS installation work without signing. Windows signing is also
optional; configure the fork's own credentials using the
[signing sections of the release guide](./release.md#2-apple-signing--notarization-setup-macos).
If Apple signing is added later, test an actual old-to-new signed update before
relying on it. Other supported desktop installations can use the normal update
action, which still asks the user to download and restart.

## Move existing installations onto the fork feed

For an easy Mac desktop or Linux CLI download, use the fork staging installer:

```sh
curl -fsSL https://raw.githubusercontent.com/nitya-ranjan/t3code/nitya/release/scripts/install-fork.sh -o /tmp/install-t3-fork.sh
sh /tmp/install-t3-fork.sh --stage
```

It selects the latest published fork nightly, verifies release checksums and
provenance, and prints a local installation command pinned to that version.
Use `--version <version>` to select a specific release. Staging leaves installed
applications and running chats alone; finish installation locally after stopping
the app or server. `--status` shows the local staging/installation receipt.

The private `nitya-ranjan/t3code-fleet` repository provides an **Update fleet**
Actions workflow and runner enrollment instructions. It stages releases on
enrolled machines daily or on demand; it never installs or restarts them.
Offline runners wait in GitHub's queue. Public release builds continue to use
GitHub-hosted runners; personal-machine runners belong only to the private
staging repository. Mobile enrollment and distribution are deferred.

The original `0.0.44-preview.20260930.1` desktop build deliberately has no update
feed. Install one of the new fork `nightly` desktop releases manually on each
machine. macOS continues to require manual installation for subsequent releases.
Keep the same T3 home to retain saved threads and settings, and stop the previous
app before starting its replacement. Before the first V2 build, back up that home;
do not launch an older build against the upgraded database.

For standalone servers, use the fork installer from the checked-in release branch:

```sh
curl -fsSL https://raw.githubusercontent.com/nitya-ranjan/t3code/nitya/release/scripts/install.sh | T3CODE_CHANNEL=nightly sh
```

On Windows:

```powershell
$env:T3CODE_CHANNEL = 'nightly'
irm https://raw.githubusercontent.com/nitya-ranjan/t3code/nitya/release/scripts/install.ps1 | iex
```

These commands require a published fork release with CLI archives. Thereafter,
`t3 update` follows the installed fork channel; managed services can also use the
existing remote update action. For an old service launched from a source checkout,
stop it at a suitable time and reinstall its launcher using the new fork CLI,
preserving the same T3 home and startup options. A source checkout or existing
official/npm install does not acquire the new updater merely by existing on the
same machine. Do not use `npx t3`, upstream installers, Homebrew, winget, or AUR to
update a fork installation: those distribute the official build.

Server updates can interrupt active work. The existing update confirmation and
optional restart continuation settings still apply; the sync workflow never
restarts machines or changes their data.
