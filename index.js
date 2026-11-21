// DSH statusline 的 Host half：在 Host 侧执行只读 git 命令，并通过
// Connection 的精确 Fetch 路由把结果交给浏览器半侧。
// 这里只用 Node 内置模块，保证插件以文件 URL 形式加载时没有任何解析依赖。
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";

/**
 * 渲染自检：只有显式设置 DSH_STATUSLINE_REPORT=1 时才写日志，
 * 并写到系统临时目录——安装目录归包管理器管，插件不往里写运行时文件。
 */
const REPORT_ENABLED = process.env.DSH_STATUSLINE_REPORT === "1";
const REPORT_PATH = REPORT_ENABLED ? join(tmpdir(), "dsh-statusline-render.log") : null;

export const name = "statusline";

/** 只等待 Connection 服务就绪；git 通过 node:child_process 直接执行。 */
export const inject = ["connection"];

/** 同一工作目录在短时间内的重复查询复用结果，避免多窗口/多轮询打爆 git。 */
const CACHE_TTL_MS = 800;
/** 单条 git 命令的上限。状态条不是阻塞路径，超时就退回“无仓库信息”。 */
const GIT_TIMEOUT_MS = 5000;

/** cwd -> { at, value } */
const cache = new Map();

/**
 * 执行一条只读 git 命令。
 * @param {string} cwd - 命令工作目录。
 * @param {string[]} args - 子命令与其参数。
 * @returns {Promise<string|null>} 去掉首尾空白的标准输出；失败或超时返回 null。
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "-c", "core.quotepath=false", ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) resolve(null);
        else resolve(String(stdout).replace(/\s+$/, ""));
      },
    );
  });
}

/**
 * 解析 `status --porcelain=v2 --branch` 的输出，按修改/新增/删除分类计数。
 * @param {string|null} output - git 标准输出。
 * @returns {{ branch?: string, detached?: boolean, oid?: string, ahead?: number, behind?: number, dirty?: boolean, files?: number, modified?: number, added?: number, deleted?: number }}
 */
function parseStatus(output) {
  if (output === null) return {};
  const result = { dirty: false, files: 0, modified: 0, added: 0, deleted: 0, ahead: 0, behind: 0 };
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
      result.added += 1;
      result.files += 1;
      result.dirty = true;
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      // porcelain v2 普通变更行：`<type> <XY> ...`
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
 * 采集一个工作目录的仓库状态。
 * @param {string} cwd - 会话工作目录。
 * @returns {Promise<object>} 状态条需要的字段；不在仓库内时只回 cwd。
 */
async function collect(cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null || top === "") return { cwd, inRepo: false };

  const [gitDir, commonDir, statusOut] = await Promise.all([
    git(top, ["rev-parse", "--absolute-git-dir"]),
    git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(top, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"]),
  ]);

  const status = parseStatus(statusOut);
  const normalizedGitDir = gitDir === null ? null : normalize(gitDir);
  const normalizedCommonDir = commonDir === null ? null : normalize(commonDir);
  // linked worktree：git 目录位于公共目录的 worktrees/<name> 下。
  const linked =
    normalizedGitDir !== null &&
    normalizedCommonDir !== null &&
    normalizedGitDir.toLowerCase() !== normalizedCommonDir.toLowerCase();
  const worktree = linked ? basename(normalizedGitDir) : null;
  const repo = normalizedCommonDir === null ? null : basename(dirname(normalizedCommonDir));

  return {
    cwd,
    inRepo: true,
    top,
    repo,
    worktree,
    linked,
    branch: status.branch ?? null,
    detached: status.detached === true,
    oid: status.oid ?? null,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    dirty: status.dirty === true,
    files: status.files ?? 0,
    modified: status.modified ?? 0,
    added: status.added ?? 0,
    deleted: status.deleted ?? 0,
  };
}

/**
 * 带短 TTL 的采集入口。
 * @param {string} cwd - 会话工作目录。
 * @returns {Promise<object>} 采集结果。
 */
async function collectCached(cwd) {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await collect(cwd);
  cache.set(cwd, { at: now, value });
  if (cache.size > 64) {
    for (const [key, entry] of cache) {
      if (now - entry.at > CACHE_TTL_MS * 10) cache.delete(key);
    }
  }
  return value;
}

/**
 * 输出 JSON 响应。
 * @param {unknown} body - 要序列化的内容。
 * @param {number} status - HTTP 状态码。
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
 * 安装 Host 侧精确路由。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 插件上下文。
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
          if (cwd === null || cwd.length === 0 || cwd.length > 4096 || !isAbsolute(cwd)) {
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

  // 渲染自检：浏览器半侧把状态条实际显示的文本回报到这里，
  // 便于在不打开浏览器的情况下核对渲染结果。
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: "/api/statusline/report",
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          try {
            const body = await request.text();
            if (REPORT_PATH !== null && body.length > 0 && body.length <= 8192) {
              appendFileSync(
                REPORT_PATH,
                new Date().toISOString() + " " + body + "\n",
              );
            }
          } catch {
            // 自检失败不影响状态条本身。
          }
          return new Response("ok");
        },
      }),
    "statusline: render report route",
  );
}
