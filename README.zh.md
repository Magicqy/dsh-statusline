# dsh-statusline

在 DeepSeek Harness 窗口底部加一行状态条：当前会话所在仓库的分支、worktree、工作目录、未提交改动、ahead/behind，以及上下文占用。

## 显示内容

| 段 | 来源 | 说明 |
|---|---|---|
| 分支 | `git status --porcelain=v2 --branch` | 游离 HEAD 时显示「游离」 |
| 工作树 | `rev-parse --absolute-git-dir` 与 `--git-common-dir` 对比 | 只在 linked worktree 下显示 |
| 目录 | 会话 cwd | 超长省略 |
| 改动 | porcelain v2 | 修改 / 新增 / 删除分别计数 |
| 同步 | `branch.ab` | ahead / behind |
| 上下文 | 客户端 sessions store | 当前会话的上下文占用 |

不在 git 仓库里时只显示目录，并标「非 git 仓库」。

## 安装

**桌面端**：插件 → 添加插件，填包名 `dsh-statusline`（发布到 npm 后）。桌面端的 profile 由应用自己管理，命令行装不进去。

**普通 `dsh web`**：

```sh
dsh plugin --profile web add dsh-statusline
```

**没发 npm 时从 GitHub 直装**：

```sh
dsh plugin --profile web add github:OWNER/dsh-statusline
```

装完重启 DSH（或刷新页面）。

## 要求

- `git` 在 PATH 里。插件只执行只读命令，超时 5 秒，失败时退回「无仓库信息」。
- DSH `0.2.2-rc.x`；实测 `0.2.2-rc.5`。

## 数据与隐私

- 只读：`rev-parse --show-toplevel`、`rev-parse --absolute-git-dir`、`rev-parse --path-format=absolute --git-common-dir`、`status --porcelain=v2 --branch`。
- 两个同源路由：`GET /api/statusline/git?cwd=<绝对路径>`、`POST /api/statusline/report`。
- 状态条内容不落盘。只有显式设置 `DSH_STATUSLINE_REPORT=1` 时，自检日志才写到系统临时目录的 `dsh-statusline-render.log`。

## 卸载

插件管理器里卸载，或：

```sh
dsh plugin --profile web remove dsh-statusline
```

## 开发

`index.js` 是 Host 半侧（Node 内置模块，无第三方依赖），`client.js` 是浏览器半侧（占用 `shell.bottom` 槽位，通过 `require("react")` 取宿主依赖）。

本地改动直接编辑两个文件；用 profile 里的 `file:` 行加载时不经过包管理器。要验证打包形态，用 `npm pack --dry-run` 看文件清单，再在非桌面 profile 里 `dsh plugin add <目录>` 实测。

## 许可

MIT
