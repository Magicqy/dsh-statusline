# dsh-statusline

One line at the bottom of DeepSeek Harness: the current session's git branch, worktree, working directory, uncommitted changes, and ahead/behind.

## What it shows

| Segment | Label | Source |
|---|---|---|
| Branch | `branch` | `git status --porcelain=v2 --branch`; a detached HEAD shows the short commit |
| Worktree | `worktree` | always shown; the checkout directory name, with the repository path in the tooltip |
| Directory | `cwd` | the session's cwd, last path segment; hover for the full path |
| Changes | `changes` | porcelain v2, split into `*` modified / `+` added / `?` untracked / `-` deleted; counts are paths, so an untracked directory counts once |
| Sync | `↑a ↓b` | `branch.ab` ahead / behind, shown only when non-zero |

Outside a repository it shows the directory and "not a git repository". If `git` is missing or does not answer within 5 seconds, the row says `git not found` or `git timed out` instead of pretending the directory is not a repository. The row appears only while a session with a working directory is open; the empty start screen has nothing to show.

## Install

The plugin is distributed from this repository.

**Desktop app** — the app owns its profile and ships no `dsh` command:

1. Clone this repository (`git clone https://github.com/Magicqy/dsh-statusline`).
2. In DeepSeek Harness open **Plugins → Add plugin** and choose the cloned folder.
3. Restart DeepSeek Harness.

**`dsh` CLI** — install from the repository into the profile you use:

```sh
dsh plugin --profile <profile> add github:Magicqy/dsh-statusline
```

Then restart DeepSeek Harness: a page refresh reloads the browser half but does not load the Host half.

**Plugin market** — once this repository is listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) catalog, dsh-market shows the entry and installs it from the GitHub source.

## Requirements

- `git` on PATH. Only read-only commands run, with a 5 s timeout; a missing or slow `git` is reported as such instead of being shown as "not a git repository".
- DSH `0.2.2-rc.x`; developed and tested on `0.2.2-rc.5`. The client reads the sessions store shape (`retainedBy`, `projectionsBySession`), so a future release may need an update.

## Privacy

- Read-only git: `rev-parse` and `status --porcelain=v2`.
- Two routes under the harness's normal same-origin authentication: `GET /api/statusline/git?cwd=<absolute path>` and `POST /api/statusline/report`.
- Nothing is written to disk unless `DSH_STATUSLINE_REPORT=1` is set, in which case the self-check log goes to the OS temp directory.

## Uninstall

Remove it in the plugin manager, or `dsh plugin --profile <profile> remove dsh-statusline`.

## Development

`index.js` is the Host half (Node built-ins only) and `client.js` the browser half, which claims the `shell.bottom` slot and reads `react` from the host module loader.

Edit the files in a checkout directly: a page refresh reloads `client.js`, while a change to `index.js` needs a DSH restart. To test the packaged form instead of a linked checkout, install this repository into a disposable profile with `dsh plugin --profile <profile> add <absolute path>`.

## License

MIT
