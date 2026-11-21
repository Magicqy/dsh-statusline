// DSH statusline browser half: claims the layout's `shell.bottom` slot and shows
// the active session's git branch, linked worktree, working directory, change
// counts and ahead/behind. The cwd comes from the client sessions store; git
// state is polled from the `/api/statusline/git` route the Host half registers.
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

    /** Client dependencies: slot registration and the sessions store. */
    const inject = ["slots", "sessions"];
    /** Poll interval for git state. */
    const POLL_MS = 3000;

    /** Same-origin API URL, relative to the page so a prefixed deployment keeps working. */
    function apiUrl(path) {
      const base = typeof document !== "undefined" && document.baseURI ? document.baseURI : window.location.href;
      return new URL("api/" + path, base).toString();
    }

    /** Every style this frame uses lives here, so it cannot collide with host CSS Modules. */
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
      separator: {
        opacity: "0.35",
        padding: "0 8px",
      },
    };

    /**
     * Pick the session the main view holds. The slot lives in the root scope, so
     * prefer an explicit `sessionId` prop; otherwise count the framework's
     * `retainedBy.mainView` references, then try the store's own active-id fields.
     * Every step is optional: an unknown store shape returns undefined, not a throw.
     * @param {object} state - sessions store snapshot.
     * @param {string|undefined} preferred - session id supplied by the slot, if any.
     * @returns {string|undefined} session id.
     */
    function selectSessionId(state, preferred) {
      if (!state) return undefined;
      const byId = state.byId;
      if (!byId) return undefined;
      if (typeof preferred === "string" && byId[preferred] !== undefined) return preferred;
      const ids = Array.isArray(state.ids) ? state.ids : Object.keys(byId);
      for (const id of ids) {
        const row = byId[id];
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
      }
      for (const key of ["activeSessionId", "selectedSessionId", "currentSessionId"]) {
        const value = state[key];
        if (typeof value === "string" && byId[value] !== undefined) return value;
      }
      return undefined;
    }

    /**
     * Last path segment, used for the narrow layout.
     * @param {string} value - absolute path.
     * @returns {string}
     */
    function lastSegment(value) {
      const trimmed = value.replace(/[\\/]+$/, "");
      const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      const segment = index === -1 ? trimmed : trimmed.slice(index + 1);
      // A filesystem root ("/", "C:\") has no last segment; show the path instead of nothing.
      return segment.length > 0 ? segment : value;
    }

    /**
     * Whether two paths point at the same directory, ignoring separators and case.
     * @param {unknown} a - path A.
     * @param {unknown} b - path B.
     * @returns {boolean}
     */
    function samePath(a, b) {
      if (typeof a !== "string" || typeof b !== "string") return false;
      const norm = (value) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
      return norm(a) === norm(b);
    }

    /**
     * Render one "label value" segment.
     * @param {string} key - React key, independent of any localisation.
     * @param {string} label - label text.
     * @param {string} value - value text.
     * @param {object} valueStyle - style for the value.
     * @param {string} title - hover text.
     * @param {object} [extraStyle] - extra layout style merged onto the segment.
     * @returns {object} React element.
     */
    function segment(key, label, value, valueStyle, title, extraStyle) {
      return jsxs(
        "span",
        {
          style: extraStyle ? { ...STYLES.segment, ...extraStyle } : STYLES.segment,
          title,
          children: [
            jsx("span", { style: STYLES.label, children: label }),
            jsx("span", { style: valueStyle, children: value }),
          ],
        },
        key,
      );
    }

    /**
     * Status bar component. Props are assembled by the slot renderer:
     * `useStatusSessions` comes from the sessions source this plugin injects.
     * @param {object} props - slot props.
     * @returns {object|null} status bar element; null while there is no session.
     */
    function StatusBar(props) {
      const useStatusSessions = typeof props.useStatusSessions === "function" ? props.useStatusSessions : () => undefined;

      const sessionIdProp = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : undefined;
      const liveId = useStatusSessions((state) => selectSessionId(state, sessionIdProp));
      // Opening a global panel (plugins, settings) makes the main view release its
      // session; keep the last known one so the bar does not vanish there.
      const lastIdRef = react.useRef(undefined);
      react.useEffect(() => {
        if (liveId !== undefined) lastIdRef.current = liveId;
      }, [liveId]);
      const sessionId = liveId !== undefined ? liveId : lastIdRef.current;

      const cwd = useStatusSessions((state) => {
        if (!state || sessionId === undefined) return undefined;
        // A later working_directory change lives in the workingDirectory projection;
        // the row's own cwd is the directory the session was created in.
        const projected = state.projectionsBySession?.[sessionId]?.values?.workingDirectory;
        if (typeof projected === "string" && projected.length > 0) return projected;
        const row = state.byId ? state.byId[sessionId] : undefined;
        // Known spellings first, then older/newer placements of the same value.
        const candidates = [row?.cwd, row?.header?.cwd, row?.meta?.cwd, row?.summary?.cwd];
        for (const value of candidates) {
          if (typeof value === "string" && value.length > 0) return value;
        }
        return undefined;
      });
      const [git, setGit] = react.useState(null);

      react.useEffect(() => {
        if (typeof cwd !== "string" || cwd.length === 0) {
          setGit(null);
          return undefined;
        }
        let cancelled = false;
        let timer = undefined;
        let controller = null;
        let inFlight = false;
        let abortRequested = false;
        const load = async () => {
          if (cancelled || inFlight) return;
          inFlight = true;
          abortRequested = false;
          controller = typeof AbortController === "function" ? new AbortController() : null;
          try {
            const response = await fetch(apiUrl("statusline/git?cwd=" + encodeURIComponent(cwd)), {
              credentials: "same-origin",
              ...(controller === null ? {} : { signal: controller.signal }),
            });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const data = await response.json();
            if (!cancelled && !abortRequested) setGit(data);
          } catch (error) {
            if (!cancelled && !abortRequested) setGit({ error: String(error) });
          } finally {
            inFlight = false;
            controller = null;
            // Schedule only once this run settled, so a slow request cannot stack
            // up behind the interval, and stay quiet while the tab is hidden.
            if (!cancelled && !abortRequested) {
              timer = setTimeout(() => {
                timer = undefined;
                void load();
              }, POLL_MS);
            }
          }
        };
        const start = () => {
          if (inFlight || timer !== undefined) return;
          void load();
        };
        const stop = () => {
          abortRequested = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (controller !== null) {
            controller.abort();
            controller = null;
          }
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

      // Render self-check: report what is actually shown to the Host when it
      // changes, so the rendering can be checked without watching the window.
      const reportRef = react.useRef("");
      const reportPayload = JSON.stringify({
        sessionId,
        cwd,
        branch: git !== null && git.inRepo === true ? git.branch ?? null : null,
        detached: git !== null ? git.detached === true : null,
        inRepo: git !== null ? git.inRepo === true : null,
        dirty: git !== null ? git.dirty === true : null,
        files: git !== null ? git.files ?? 0 : null,
        worktree: git !== null ? git.worktree ?? null : null,
        untracked: git !== null ? git.untracked ?? null : null,
        ahead: git !== null ? git.ahead ?? null : null,
        behind: git !== null ? git.behind ?? null : null,
        statusUnavailable: git !== null ? git.statusUnavailable ?? null : null,
        unavailable: git !== null ? git.unavailable ?? null : null,
      });
      react.useEffect(() => {
        if (typeof cwd !== "string" || cwd.length === 0) return;
        if (reportPayload === reportRef.current) return;
        reportRef.current = reportPayload;
        void fetch(apiUrl("statusline/report"), {
          method: "POST",
          credentials: "same-origin",
          body: reportPayload,
        }).catch(() => {});
      }, [reportPayload]);

      if (typeof cwd !== "string" || cwd.length === 0) return null;

      // Use a git result only when it was fetched for this exact cwd, so switching
      // directories cannot briefly show the previous directory's data.
      const ready = git !== null && samePath(git.cwd, cwd);
      const inRepo = ready && git.inRepo === true;
      // A failed `git status` is neither clean nor dirty; say so instead of showing 0.
      const statusFailed = git !== null && typeof git.statusUnavailable === "string" ? git.statusUnavailable : null;
      // Tell "still loading", "git is unusable" and "no repository" apart: a missing
      // git or a dead route must not read as an empty session.
      const unavailable = git !== null && typeof git.unavailable === "string" ? git.unavailable : null;
      const failureText =
        unavailable === "git-missing"
          ? "git not found"
          : unavailable === "git-timeout"
            ? "git timed out"
            : unavailable !== null
              ? "git unavailable"
              : git !== null && typeof git.error === "string"
                ? "git unavailable"
                : null;
      const failureTitle =
        failureText === null
          ? null
          : unavailable === "git-missing"
            ? "`git` is not on PATH"
            : unavailable === "git-timeout"
              ? "`git` did not answer within 5 seconds"
              : String(git.error ?? "the statusline route did not answer");

      const branchText =
        failureText ??
        (!ready
          ? "…"
          : inRepo
            ? git.detached === true
              ? lastSegment(git.oid === null || git.oid === undefined ? "detached" : git.oid.slice(0, 7))
              : String(git.branch ?? "?")
            : "not a git repository");
      const branchTitle =
        failureTitle ??
        (!ready
          ? "…"
          : inRepo
            ? git.detached === true
              ? "detached HEAD"
              : String(git.branch ?? "?")
            : "not a git repository");

      // Everything is left aligned: branch · worktree · cwd · changes [· ↑a↓b]
      const parts = [];
      parts.push(
        segment("branch", "branch", branchText, STYLES.value, branchTitle),
      );
      // The worktree segment is always present and names the checkout directory;
      // the repository path sits in the tooltip.
      const worktreeText = failureText !== null ? "-" : !ready ? "…" : inRepo ? String(git.worktree ?? "?") : "-";
      const worktreeTitle =
        failureTitle ??
        (!ready ? "…" : inRepo ? String(git.top ?? "") : "not a git repository");
      parts.push(
        segment("worktree", "worktree", worktreeText, STYLES.value, worktreeTitle),
      );
      parts.push(segment("cwd", "cwd", lastSegment(cwd), STYLES.value, cwd));

      {
        // The changes segment always occupies its slot: 0 when clean, *modified
        // +added ?untracked -deleted when dirty, - outside a repository, … before
        // the first result.
        const counts = [];
        if (inRepo) {
          if (git.modified > 0) counts.push("*" + String(git.modified));
          if (git.added > 0) counts.push("+" + String(git.added));
          if (git.untracked > 0) counts.push("?" + String(git.untracked));
          if (git.deleted > 0) counts.push("-" + String(git.deleted));
        }
        const changed = counts.length > 0;
        const changesText =
          failureText !== null
            ? "-"
            : statusFailed !== null
              ? "?"
              : !ready
                ? "…"
                : inRepo
                  ? changed
                    ? counts.join(" ")
                    : "0"
                  : "-";
        const changesTitle =
          failureTitle ??
          (statusFailed !== null
            ? "git status failed: " + statusFailed
            : !ready
              ? "…"
              : inRepo
                ? (changed ? "uncommitted changes" : "clean working tree") +
                  " " +
                  String(git.files ?? 0) +
                  (git.files === 1 ? " path" : " paths")
                : "not a git repository");
        parts.push(
          segment("changes", "changes", changesText, STYLES.value, changesTitle, {
            flexShrink: 0,
            whiteSpace: "nowrap",
          }),
        );
      }
      if (inRepo && (git.ahead > 0 || git.behind > 0)) {
        const ahead = git.ahead ?? 0;
        const behind = git.behind ?? 0;
        const ab = [];
        if (ahead > 0) ab.push("↑" + String(ahead));
        if (behind > 0) ab.push("↓" + String(behind));
        const abTitle = String(ahead) + " ahead, " + String(behind) + " behind";
        parts.push(
          jsx(
            "span",
            {
              style: { ...STYLES.value, flexShrink: 0, whiteSpace: "nowrap" },
              title: abTitle,
              "aria-label": abTitle,
              children: ab.join(" "),
            },
            "ahead-behind",
          ),
        );
      }

      const titleParts = [];
      if (failureTitle !== null) titleParts.push(failureTitle);
      else if (inRepo) {
        titleParts.push(git.dirty === true ? "uncommitted changes" : "clean working tree");
        if (git.branch) titleParts.push(git.branch);
        if (git.worktree) titleParts.push("worktree " + git.worktree);
        if (git.repo) titleParts.push("repo " + git.repo);
      }
      titleParts.push(cwd);

      // One sentence for assistive tech; the row itself stays purely visual.
      const accessibleLabel =
        failureText !== null
          ? "Git status unavailable: " + failureText
          : statusFailed !== null
            ? "Git status unavailable: git status failed"
            : inRepo
            ? "Git status: branch " +
              branchText +
              ", worktree " +
              String(git.worktree ?? "") +
              ", " +
              String(git.modified ?? 0) +
              " modified, " +
              String(git.added ?? 0) +
              " added, " +
              String(git.untracked ?? 0) +
              " untracked, " +
              String(git.deleted ?? 0) +
              " deleted" +
              ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0
                ? ", " + String(git.ahead ?? 0) + " ahead, " + String(git.behind ?? 0) + " behind"
                : "") +
              ", at " +
              cwd
            : ready
              ? "Git status: not a git repository, at " + cwd
              : "Git status: loading";

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
          role: "group",
          "aria-label": accessibleLabel,
          title: titleParts.join(" · "),
          children: rowChildren,
        },
        "statusline",
      );
    }

    /**
     * Install the browser half: mount the status bar into the layout's bottom slot.
     * @param {import("@deepseek-ai/cordis").Context} ctx - client plugin context.
     */
    function apply(ctx) {
      const injectProps = () => ({
        hooks: { statusSessions: ctx.sessions.list },
      });
      ctx.effect(
        () =>
          ctx.slots.inject("shell.bottom", () =>
            ctx.slots.register(
              {
                name: "shell.bottom",
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
