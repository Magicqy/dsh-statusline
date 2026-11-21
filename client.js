// DSH statusline 的浏览器 half：占用布局框架的 `shell.bottom` 槽位，
// 显示当前会话工作目录的 git 分支、worktree、脏标记、ahead/behind 与上下文占用。
// 数据分两类：cwd 与上下文占用直接从客户端 sessions store 读取，
// git 状态通过 Host 侧注册的 `/statusline/git` 精确路由轮询。
window.__ModuleLoader__.load({
  id: "dsh-statusline",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** 本插件拥有的 locale 命名空间。 */
    const NS = "statusline";
    /** 客户端依赖：槽位注册、会话 store 与词典。 */
    const inject = ["slots", "sessions", "locale"];
    /** git 状态轮询间隔。 */
    const POLL_MS = 3000;

    const zh = {
      branch: "分支",
      cwd: "目录",
      ctx: "上下文",
      worktree: "工作树",
      detached: "游离",
      dirty: "有未提交改动",
      clean: "工作区干净",
      noRepo: "非 git 仓库",
    };
    const en = {
      branch: "branch",
      cwd: "cwd",
      ctx: "ctx",
      worktree: "worktree",
      detached: "detached",
      dirty: "uncommitted changes",
      clean: "clean working tree",
      noRepo: "not a git repository",
    };

    /** 帧内所有样式集中在这里，避免与宿主模块的 CSS Modules 交叉。 */
    const STYLES = {
      root: {
        display: "flex",
        alignItems: "center",
        gap: "0",
        height: "26px",
        padding: "0 12px",
        boxSizing: "border-box",
        borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
        color: "var(--dsw-alias-label-secondary, #8b8f96)",
        fontFamily: "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
        fontSize: "12px",
        lineHeight: "26px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        userSelect: "none",
      },
      segment: {
        display: "inline-flex",
        alignItems: "baseline",
        gap: "5px",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      label: {
        opacity: "0.65",
      },
      value: {
        color: "var(--dsw-alias-label-primary, #d4d6da)",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      valueMuted: {
        color: "var(--dsw-alias-label-secondary, #8b8f96)",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      separator: {
        opacity: "0.35",
        padding: "0 8px",
      },
      accent: {
        color: "var(--dsw-alias-label-primary, #d4d6da)",
      },
      warn: {
        color: "var(--dsw-static-neutral-bluish-400, #7aa2f7)",
      },
    };

    /**
     * 选当前主视图持有的会话：root 作用域没有 sessionId，按框架的
     * `retainedBy.mainView` 计数找正在被主视图渲染的那个会话。
     * @param {object} state - sessions store 快照。
     * @returns {string|undefined} 会话 id。
     */
    function selectSessionId(state) {
      if (!state || !state.byId) return undefined;
      const ids = state.ids || [];
      for (const id of ids) {
        const row = state.byId[id];
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
      }
      return undefined;
    }

    /**
     * 取路径最后一段，用于窄屏下的降级显示。
     * @param {string} value - 绝对路径。
     * @returns {string}
     */
    function lastSegment(value) {
      const trimmed = value.replace(/[\\/]+$/, "");
      const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      return index === -1 ? trimmed : trimmed.slice(index + 1);
    }

    /**
     * 比较两个路径是否指向同一目录（忽略分隔符与大小写差异）。
     * @param {unknown} a - 路径 A。
     * @param {unknown} b - 路径 B。
     * @returns {boolean} 是否相同。
     */
    function samePath(a, b) {
      if (typeof a !== "string" || typeof b !== "string") return false;
      const norm = (value) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
      return norm(a) === norm(b);
    }

    /**
     * 渲染一个「标签 + 值」分段。
     * @param {string} label - 标签文本。
     * @param {string} value - 值文本。
     * @param {object} valueStyle - 值样式。
     * @param {string} title - 悬停提示。
     * @returns {object} React 元素。
     */
    function segment(label, value, valueStyle, title) {
      return jsxs(
        "span",
        {
          style: STYLES.segment,
          title,
          children: [
            jsx("span", { style: STYLES.label, children: label }),
            jsx("span", { style: valueStyle, children: value }),
          ],
        },
        label + ":" + value,
      );
    }

    /**
     * 状态条组件。props 由槽位渲染器组装：`useStatusSessions` 来自本插件
     * 注册时注入的 sessions source，`t` 来自 locale 字典。
     * @param {object} props - 槽位 props。
     * @returns {object|null} 状态条元素；没有会话时不占位。
     */
    function StatusBar(props) {
      const useStatusSessions = typeof props.useStatusSessions === "function" ? props.useStatusSessions : () => undefined;
      const t = typeof props.t === "function" ? props.t : (key) => key;

      const liveId = useStatusSessions(selectSessionId);
      // 切换到全局面板（插件页、设置页）时主视图会让出会话，保留最后已知的会话，
      // 避免状态条在该页面上突然消失。
      const lastIdRef = react.useRef(undefined);
      if (liveId !== undefined) lastIdRef.current = liveId;
      const sessionId = liveId !== undefined ? liveId : lastIdRef.current;

      const cwd = useStatusSessions((state) => {
        if (!state || sessionId === undefined) return undefined;
        // 会话列表的 cwd 是创建时的原始目录（header.cwd）；working_directory
        // 切换后的当前目录在 workingDirectory 会话投影里，优先读它。
        const projected = state.projectionsBySession?.[sessionId]?.values?.workingDirectory;
        if (typeof projected === "string" && projected.length > 0) return projected;
        const row = state.byId ? state.byId[sessionId] : undefined;
        return row ? row.cwd : undefined;
      });
      const [git, setGit] = react.useState(null);

      react.useEffect(() => {
        if (typeof cwd !== "string" || cwd.length === 0) {
          setGit(null);
          return undefined;
        }
        let cancelled = false;
        let timer = undefined;
        const load = async () => {
          try {
            const response = await fetch("/api/statusline/git?cwd=" + encodeURIComponent(cwd), {
              credentials: "same-origin",
            });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const data = await response.json();
            if (!cancelled) setGit(data);
          } catch (error) {
            if (!cancelled) setGit({ error: String(error) });
          }
        };
        const start = () => {
          if (timer !== undefined) return;
          void load();
          timer = setInterval(load, POLL_MS);
        };
        const stop = () => {
          if (timer === undefined) return;
          clearInterval(timer);
          timer = undefined;
        };
        const onVisibility = () => {
          if (document.hidden) stop();
          else start();
        };
        if (!document.hidden) start();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
          cancelled = true;
          stop();
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [cwd]);

      // 渲染自检：渲染内容变化时把实际状态回报给 Host，便于离线核对
      // 浏览器里真正显示的是什么（不依赖人工查看界面）。
      const reportRef = react.useRef("");
      const reportKey =
        (cwd ?? "") +
        "|" +
        (git === null
          ? "nil"
          : [String(git.branch ?? ""), String(git.inRepo === true), String(git.dirty === true), String(git.files ?? 0)].join(":"));
      react.useEffect(() => {
        if (typeof cwd !== "string" || cwd.length === 0) return;
        const payload = JSON.stringify({
          sessionId,
          cwd,
          branch: git !== null && git.inRepo === true ? git.branch ?? null : null,
          detached: git !== null ? git.detached === true : null,
          inRepo: git !== null ? git.inRepo === true : null,
          dirty: git !== null ? git.dirty === true : null,
          files: git !== null ? git.files ?? 0 : null,
        });
        if (payload === reportRef.current) return;
        reportRef.current = payload;
        void fetch("/api/statusline/report", {
          method: "POST",
          credentials: "same-origin",
          body: payload,
        }).catch(() => {});
      }, [reportKey]);

      if (typeof cwd !== "string" || cwd.length === 0) return null;

      // 只有 git 结果对应的就是当前 cwd 时才采用，避免切换目录瞬间沿用上一个目录的数据。
      const ready = git !== null && samePath(git.cwd, cwd);
      const inRepo = ready && git.inRepo === true;
      const branchText = !ready
        ? "…"
        : inRepo
          ? git.detached === true
            ? lastSegment(git.oid === null || git.oid === undefined ? "detached" : git.oid.slice(0, 7))
            : String(git.branch ?? "?")
          : t("noRepo");

      // 所有信息左对齐依次排列：br [· wt] · cwd · status [· ↑a↓b]
      const parts = [];
      parts.push(
        segment(
          "branch",
          branchText,
          inRepo ? STYLES.value : STYLES.valueMuted,
          inRepo ? git.branch ?? branchText : t("noRepo"),
        ),
      );
      if (inRepo && git.worktree && lastSegment(cwd) !== String(git.worktree)) {
        parts.push(segment("worktree", String(git.worktree), STYLES.value, t("worktree") + " " + git.top));
      }
      parts.push(segment("cwd", lastSegment(cwd), STYLES.valueMuted, cwd));

      {
        // status 段常显占位：干净时显示 0，有改动时显示 *修改 +新增 -删除，
        // 非仓库显示 -，未就绪显示 …，保证这个信息位始终存在。
        const counts = [];
        if (inRepo) {
          if (git.modified > 0) counts.push("*" + String(git.modified));
          if (git.added > 0) counts.push("+" + String(git.added));
          if (git.deleted > 0) counts.push("-" + String(git.deleted));
        }
        const changed = counts.length > 0;
        parts.push(
          jsx(
            "span",
            {
              style: changed ? STYLES.warn : STYLES.valueMuted,
              title: !ready
                ? "…"
                : inRepo
                  ? (changed ? t("dirty") : t("clean")) + " " + String(git.files ?? 0) + " 个文件"
                  : t("noRepo"),
              children: "changes " + (!ready ? "…" : inRepo ? (changed ? counts.join(" ") : "0") : "-"),
            },
            "changes",
          ),
        );
      }
      if (inRepo && (git.ahead > 0 || git.behind > 0)) {
        const ab = [];
        if (git.ahead > 0) ab.push("↑" + String(git.ahead));
        if (git.behind > 0) ab.push("↓" + String(git.behind));
        parts.push(jsx("span", { style: STYLES.accent, children: ab.join(" ") }, "ahead-behind"));
      }

      const titleParts = [];
      if (inRepo) {
        titleParts.push(git.dirty === true ? t("dirty") : t("clean"));
        if (git.branch) titleParts.push(git.branch);
        if (git.worktree) titleParts.push("worktree " + git.worktree);
        if (git.repo) titleParts.push("repo " + git.repo);
      }
      titleParts.push(cwd);

      const rowChildren = [];
      parts.forEach((part, index) => {
        if (index > 0) rowChildren.push(jsx("span", { style: STYLES.separator, children: "·" }, "sep" + String(index)));
        rowChildren.push(part);
      });

      return jsxs(
        "div",
        {
          style: STYLES.root,
          "data-dsh-statusline": "root",
          title: titleParts.join(" · "),
          children: rowChildren,
        },
        "statusline",
      );
    }

    /**
     * 安装浏览器半侧：注册词典，并把状态条挂到布局框架的底部槽位。
     * @param {import("@deepseek-ai/cordis").Context} ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "statusline: dictionaries");
      const injectProps = () => ({
        hooks: { statusSessions: ctx.sessions.list },
      });
      ctx.effect(
        () =>
          ctx.slots.inject("shell.bottom", () =>
            ctx.slots.register(
              {
                name: "shell.bottom",
                locale: NS,
                inject: injectProps,
              },
              StatusBar,
            ),
          ),
        "statusline: bottom bar",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
