// DSH statusline Host half: runs read-only git commands on the Host and hands
// the result to the browser half through an exact Fetch route on Connection.
// Only Node built-ins are used, so the plugin loads from a file URL with no
// resolution dependencies of its own.
import { execFile } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";

/**
 * Render self-check: the log is written only when DSH_STATUSLINE_REPORT=1 is set
 * explicitly, and it goes to the OS temp directory — the install directory
 * belongs to the package manager, so the plugin writes no runtime files there.
 */
const REPORT_ENABLED = process.env.DSH_STATUSLINE_REPORT === "1";
const REPORT_PATH = REPORT_ENABLED ? join(tmpdir(), "dsh-statusline-render.log") : null;
/** Cap the self-check log so a long-running session cannot grow it without bound. */
const REPORT_MAX_BYTES = 1024 * 1024;

/**
 * Whether the self-check log still has room.
 * @returns {boolean}
 */
function reportLogHasRoom() {
  if (REPORT_PATH === null) return false;
  try {
    return statSync(REPORT_PATH).size < REPORT_MAX_BYTES;
  } catch {
    return true;
  }
}

export const name = "statusline";

/** Only wait for the Connection service; git runs through node:child_process directly. */
export const inject = ["connection"];

/** Reuse a working directory's result briefly so several windows/polls cannot hammer git. */
const CACHE_TTL_MS = 800;
/** Upper bound for one git command. The status line is not a blocking path, so it degrades to "no repository info". */
const GIT_TIMEOUT_MS = 5000;

/** cwd -> { at, value } */
const cache = new Map();
/** cwd -> in-flight collection, so two windows cannot run the same commands twice. */
const pending = new Map();

/**
 * Run one read-only git command.
 * @param {string} cwd - working directory for the command.
 * @param {string[]} args - subcommand and its arguments.
 * @returns {Promise<{ stdout: string|null, failure: string|null }>} trimmed stdout, or
 *   why it failed: `git-missing` (not on PATH), `git-timeout` (killed after the limit),
 *   `git-failed` (anything else, including "not a repository").
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "-c", "core.quotepath=false", ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (!error) {
          resolve({ stdout: String(stdout).replace(/\s+$/, ""), failure: null });
          return;
        }
        const failure =
          error.code === "ENOENT"
            ? "git-missing"
            : error.killed === true || typeof error.signal === "string"
              ? "git-timeout"
              : "git-failed";
        resolve({ stdout: null, failure });
      },
    );
  });
}

/**
 * Parse `status --porcelain=v2 --branch` output into modified/added/deleted counts.
 * @param {string|null} output - git stdout.
 * @returns {{ branch?: string, detached?: boolean, oid?: string, ahead?: number, behind?: number, dirty?: boolean, files?: number, modified?: number, added?: number, untracked?: number, deleted?: number }}
 */
function parseStatus(output) {
  if (output === null) return {};
  const result = { dirty: false, files: 0, modified: 0, added: 0, untracked: 0, deleted: 0, ahead: 0, behind: 0 };
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") result.detached = true;
      else result.branch = value;
    } else if (line.startsWith("# branch.oid ")) {
      result.oid = line.slice("# branch.oid ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
    } else if (line.startsWith("? ")) {
      // Untracked paths are counted apart from staged/unstaged additions.
      result.untracked += 1;
      result.files += 1;
      result.dirty = true;
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      // porcelain v2 change line: `<type> <XY> ...`
      const xy = line.slice(2, 4);
      if (xy.includes("A")) result.added += 1;
      else if (xy.includes("D")) result.deleted += 1;
      else result.modified += 1;
      result.files += 1;
      result.dirty = true;
    }
  }
  return result;
}

/**
 * Collect repository state for one working directory.
 * @param {string} cwd - session working directory.
 * @returns {Promise<object>} fields the status line needs; only cwd outside a repository.
 */
async function collect(cwd) {
  const toplevel = await git(cwd, ["rev-parse", "--show-toplevel"]);
  // A missing or unresponsive git is not "not a repository": report it apart so the
  // row can say what is actually wrong.
  if (toplevel.failure === "git-missing" || toplevel.failure === "git-timeout") {
    return { cwd, inRepo: false, unavailable: toplevel.failure };
  }
  if (toplevel.stdout === null || toplevel.stdout === "") return { cwd, inRepo: false };
  const top = toplevel.stdout;

  const [commonDir, statusOut] = await Promise.all([
    git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(top, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"]),
  ]);

  const status = parseStatus(statusOut.stdout);
  // A failed or truncated status must not be reported as a clean tree.
  const statusUnavailable = statusOut.stdout === null ? statusOut.failure ?? "git-failed" : null;
  const normalizedCommonDir = commonDir.stdout === null ? null : normalize(commonDir.stdout);
  // The segment names the checkout directory, the way the user sees it on disk.
  const worktree = top.length > 0 ? basename(normalize(top)) : null;
  const repo = normalizedCommonDir === null ? null : basename(dirname(normalizedCommonDir));

  return {
    cwd,
    inRepo: true,
    top,
    repo,
    worktree,
    branch: status.branch ?? null,
    detached: status.detached === true,
    oid: status.oid ?? null,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    statusUnavailable,
    dirty: statusUnavailable === null && status.dirty === true,
    files: status.files ?? 0,
    modified: status.modified ?? 0,
    added: status.added ?? 0,
    untracked: status.untracked ?? 0,
    deleted: status.deleted ?? 0,
  };
}

/**
 * Cache-fronted collector; concurrent callers for one cwd share a single run.
 * @param {string} cwd - session working directory.
 * @returns {Promise<object>} collected state.
 */
async function collectCached(cwd) {
  const hit = cache.get(cwd);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const inflight = pending.get(cwd);
  if (inflight !== undefined) return inflight;
  const promise = collect(cwd)
    .then((value) => {
      // Timestamp after the work, so a slow run is not cached as already stale.
      cache.set(cwd, { at: Date.now(), value });
      if (cache.size > 64) {
        const now = Date.now();
        for (const [key, entry] of cache) {
          if (now - entry.at > CACHE_TTL_MS * 10) cache.delete(key);
        }
      }
      return value;
    })
    .finally(() => {
      pending.delete(cwd);
    });
  pending.set(cwd, promise);
  return promise;
}

/**
 * Build a JSON response.
 * @param {unknown} body - content to serialize.
 * @param {number} status - HTTP status code.
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Install the Host side: the exact routes the browser half calls.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: "/api/statusline/git",
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async (request) => {
          const url = new URL(request.url);
          const cwd = url.searchParams.get("cwd");
          // Reject UNC and device paths before git touches them: on Windows those
          // send SMB/device requests the status line has no business making.
          const unsafeWindowsPath = process.platform === "win32" && cwd !== null && cwd.startsWith("\\\\");
          if (
            cwd === null ||
            cwd.length === 0 ||
            cwd.length > 4096 ||
            !isAbsolute(cwd) ||
            unsafeWindowsPath ||
            cwd.includes("\0")
          ) {
            return json({ error: "invalid-cwd" }, 400);
          }
          try {
            return json(await collectCached(cwd));
          } catch (error) {
            return json({ error: "git-failed", message: String(error) }, 500);
          }
        },
      }),
    "statusline: git status route",
  );

  // Render self-check route, registered only while the opt-in log is enabled.
  if (REPORT_ENABLED) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: "/api/statusline/report",
          methods: ["POST"],
          requestBody: "buffered",
          fetch: async (request) => {
            try {
              const body = await request.text();
              if (body.length > 0 && body.length <= 8192 && reportLogHasRoom()) {
                // One JSON line per report: the body cannot forge extra lines.
                appendFileSync(REPORT_PATH, JSON.stringify({ at: new Date().toISOString(), body }) + "\n");
              }
            } catch {
              // A failed self-check never affects the status line itself.
            }
            return new Response("ok");
          },
        }),
      "statusline: render report route",
    );
  }
}
