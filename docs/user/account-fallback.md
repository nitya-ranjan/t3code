# Account fallback

When one account runs out of usage in the middle of a turn, T3 Code can continue
the work on the next account you have lined up, so a long task does not stall on
a usage limit. Fallback is off until you set a chain as the default or choose one
for a project.

## Set up chains

Open **Settings → Providers → Fallback chains** and create a named chain: an
ordered list of your provider accounts, such as Claude Work, then Claude
Personal, then Codex. When an account runs out, work moves to the next account
in the list that can take it, so put the one you want to run out last at the
end.

New threads in a project that uses a chain start on the chain's first account,
with that account's default model, unless the project sets its own default
model. A thread on an account that is not in its chain still falls back, to the
chain's first account that can take the work.

The same section lets you:

- Pick a **default chain** for the environment.
- Add an optional **webhook URL**. T3 Code sends a plain-text POST there each
  time it hands work off or starts waiting. An ntfy topic URL such as
  `https://<ntfy host>/<topic>` works as is, so the message arrives as a push
  notification.
- Set the limit on automatic hand-offs per thread per hour. The default is 3.
  When a thread reaches it, the thread waits until the oldest of those
  hand-offs is an hour old, then continues on the next account.

## Choose a chain per project

In a project's settings, **Fallback chain** is **Inherit** (use the
environment's default), **Off**, or a specific chain. See
[project settings](./project-settings.md) for how project overrides work.

## What happens at a limit

- **Codex accounts that share one Codex home** continue in the same thread.
- **Any other next account** gets a new thread in the same project, worktree, and
  branch. It starts with a handoff message: your requests so far, where the
  previous agent got to, and a reminder to check `git status` and `PROGRESS.md`.
  The two threads link to each other.

Accounts that are signed out, disabled, or already out of usage are skipped.

Tip: ask your agents to keep a `PROGRESS.md` in the project. A new thread picks up
much more smoothly from a written record.

## When every account is out

The thread waits and resumes on its own when an account resets. T3 Code checks
every minute, or every 15 minutes when no reset time is known. Choose
**Stop waiting** to cancel, or send your own message, which also cancels the wait.

## Pause fallback for a thread

Choose **Pause account fallback** in the thread menu of any thread in a project
that uses a chain, and usage limits behave in that thread as they did before: it
stops and shows the limit. A waiting thread stays waiting but does not resume on
its own. **Resume account fallback** turns it back on.

## Mobile

Fallback works for threads you view in the mobile app. The banners and controls
are available on desktop and web for now.
