# dsh-statusline

One line at the bottom of DeepSeek Harness: the current session's git branch, worktree, working directory, uncommitted changes, ahead/behind, and context usage.

## What it shows

| Segment | Source |
|---|---|
| Branch | `git status --porcelain=v2 --branch` (shows detached HEAD as detached) |
| Worktree | `rev-parse --absolute-git-dir` vs `--git-common-dir` (only for linked worktrees) |
| Directory | the session's cwd |
| Changes | porcelain v2, split into modified / added / deleted |
| Sync | `branch.ab` ahead / behind |
| Context | the client sessions store |

Outside a repository it shows the directory and "not a git repository".

## Install

Desktop: **Plugins → Add plugin**, enter `dsh-statusline` (after it is on npm). The desktop profile is owned by the app; the CLI cannot install into it.

Plain `dsh web`:

```sh
dsh plugin --profile web add dsh-statusline
```

From GitHub before an npm release:

```sh
dsh plugin --profile web add github:OWNER/dsh-statusline
```

Restart DSH (or refresh the page) afterwards.

## Requirements

- `git` on PATH. Only read-only commands run, with a 5 s timeout; failures degrade to "no repository info".
- DSH `0.2.2-rc.x` (tested on `0.2.2-rc.5`).

## Privacy

- Read-only git: `rev-parse` and `status --porcelain=v2`.
- Two same-origin routes: `GET /api/statusline/git?cwd=<absolute path>` and `POST /api/statusline/report`.
- Nothing is written to disk unless `DSH_STATUSLINE_REPORT=1` is set, in which case the self-check log goes to the OS temp directory.

## Uninstall

Remove it in the plugin manager, or `dsh plugin --profile web remove dsh-statusline`.

## License

MIT
