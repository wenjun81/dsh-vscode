# dsh-vscode 开发笔记

面向后续维护者（包括未来的自己）的架构与坑位速查。详细演进过程见 Git 历史。

## 架构：Host / Client 两半体

- `index.js`（Host 半体）：导出 `name` / `inject` / `apply(ctx, rawConfig)`，在 `apply` 里经 `ctx.inject(['connection'])` 后 `connection.rpc.handle('/vscode-sidebar', handler)` 注册 RPC 通道。
- `client.js`（Client 半体）：`window.__ModuleLoader__.load({ id: 'dsh-vscode', factory })`，React 手写 `h()`（无 JSX），注册三个槽位：
  - `sidebar.panellist` → `{ id: 'vscode-sidebar', order: 30, label }`（左侧栏图标）；
  - `main` → `{ key: 'vscode-sidebar' }`（主面板）；
  - `shell.overlay` → `{ id: 'vscode-workbench', order: 25 }`（悬浮工作台，用 `react-dom.createPortal` 挂到 `document.body`）。
- 通信：`connection.rpc.call('/vscode-sidebar', endpoint, payload)`；宿主端 handler 返回 `{ok, value | error}`。

## 服务契约（DSH 运行时，非 npm 库）

- 投递普通会话：`sessionController.prompt({requestId, sessionId, mode:'queue', content})`。
- **subagent 守卫**：`origin==='subagent'`（或 parent 被 agent 持有）的会话对 `sessionController` 一切入口抛 `"session ... is owned by subagent routing"`（`dsh-api-session-controller` 的 `hasApiSessionSubagentOwner`，无豁免）。合法投递路径 = `subagents.prompt({requestId, parentSessionId, childSessionId, mode:'continuable', delivery:'queue'|'steer', content})`。
- **附件暂存协议**：prompt 的 file 块必须带 `receiptId`，且 receipt 须由 `fileUploads.uploadStream({sessionId, data: AsyncIterable<Uint8Array>, name})` 为同一会话暂存；直接 `attachments.saveFile` 的引用会被 `resolvePromptFileReceipts` 拒绝（`"File was not uploaded for this session."`，reason FILE_NOT_STAGED）。subagent 会话不支持 file 块（`SUBAGENT_FILE_UNSUPPORTED`）。
- 当前对话 id（Client 侧）：`ctx.get('uiSession').adapter.current.getSnapshot().key`（订阅式 store）。必须精确投递「当前对话」——盲取首个非 blank 会话会误投后台子代理壳（真实事故）。
- 文件读写：`fs.resolve/stat/readText/readBytes/writeText/listDir/watch`；`fs.watch(target, onChanged, signal)` 返回 close 函数；`writeText` 不传 sandboxPolicy 用后端默认沙箱，拒绝原因如实返回。

## 坑位清单（每个都真实踩过）

1. **slot 注册必须带 `name` 字段**（=槽名），否则入口静默不出现。
2. **CSS 变量 `--dsw-alias-*` 在插件 DOM 内不解析**：background 声明被丢弃 → 按钮落回 UA 浅灰底 + 白字 = 隐形白图标。全部使用具体色值/`rgba`，文字色用 `inherit` 兼容明暗主题。
3. **React hooks 顺序**：`useMemo` 等必须写在条件早退 `return` 之前，否则组件崩溃。
4. **ELECTRON_RUN_AS_NODE**：宿主沙箱环境带 `ELECTRON_RUN_AS_NODE=1`，spawn Electron 系程序（VS Code）会秒退 exit=1。子进程 env 必须覆盖 `{ ...process.env, ELECTRON_RUN_AS_NODE: '' }`。
5. **.lnk 启动**：spawn 直接启 .lnk 失败；用 `explorer.exe <lnk>` 等价双击（explorer 委托后自身 exit=1 属正常）。
6. **fs.stat 裸路径**会被按相对路径解析而失败——必须先 `fs.resolve()`（本插件全部读盘一致）。
7. **拖拽遮罩残留**：DSH 官方投放遮罩（`dsh-client-ui-attachment` 的 `installDocumentDropEvents`）监听 document 上的 drop 与 window 上的 dragend 收尾。任何落点 `stopPropagation()` 挡住 drop 后遮罩永不消失；处理后必须 `window.dispatchEvent(new Event('dragend'))` 触发官方 reset。
8. **h() 调用尾逗号**：最后一个实参后写逗号 → 逗号运算符 → `Unexpected token '}'`（曾经让客户端半体整个解析失败）。
9. **探针即契约**：客户端保存 client.js 会触发 HMR 自动重载；宿主改动需插件管理器禁用→启用。探针（默认关）是唯一可靠的端到端取证手段。
10. **客户端模块 id 必须与包名一致**：`window.__ModuleLoader__.load({ id })` 的 id 必须等于该包被加载时使用的包名，否则客户端半体静默不激活（宿主正常、侧栏无图标、工作台消失、无任何报错）——实测于把包临时改名切换时（id 'dsh-vscode' vs 装载名 '@local/vscode-sidebar'）。

## 验证方法

```powershell
node --check index.js; node --check client.js   # 语法
# 客户端上线：cordis_inspect_query client Slots.listSubTree {root:'sidebar.panellist'} 应含 vscode-sidebar
# 端到端：config.probeEnabled=true 后看 %TEMP%\dsh-vscode\spawn-probe.log / client-loaded.log
```

## 版本线（发布前）

- 0.x 系列为个人自用迭代（2026-11-02 → 11-03，v0.1→v0.9.4：侧栏入口修复、精确投递、原文件附件、暂存区、多标签工作台、语法着色、拖拽排序、快捷方式启动）。
- 1.0.0 = 首个公开发行版：去个人化、配置系统（vscodePath/probeEnabled/probeDir/desktopShortcut）、跨平台探测链、MIT、黑白图标。
- 1.1.0 = 精简重构（功能不变）：删 attachments.saveFile 死分支与 v0.1 遗留端点（sendFileToDsh/sendTextToDsh/listSessions）、三路文本降级合并为 deliverTextFallback、四个 spawn 块合并为 launchVsCode、探针收敛（index.js 790→659 行 ≈ -17%，client.js logClient 17→7）。
- 1.1.1 = 修复「发送失败：session ... is already owned by an active write handle」：GUI 打开对话后 agent 恢复（open('write')）尚未完成时，插件 prompt 撞写句柄被拒。新增 withWriterHeldRetry（对 code session/writer-held 或 message 含 active write handle 的错误重试 4 次、间隔 1.5s）；耗尽后返回明确指引文案。同时移除宿主错误消息里重复的「发送失败：」前缀（客户端已加）。
- 1.1.1 发布时包名改为 @wenjun81/dsh-vscode（npm 上 dsh-vscode 已被他人 2026-08 占名）：package.json name、client.js 模块 id、index.js 导出 name、cordis.patch.yml 槽位 id/name 四处必须同步改，否则客户端半体静默不激活（见坑位 10）。
