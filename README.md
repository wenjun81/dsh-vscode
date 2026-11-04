# dsh-vscode

DeepSeek Harness（DSH）侧边栏插件：把 VS Code 桥接进 DSH 对话。

侧边栏新增「VScode」入口，主面板提供：

- **打开 VS Code**：自动探测安装位置（Windows/macOS/Linux），一键启动，可携带工作区；也支持打开文件（`-g` 跳到指定行列）。
- **工作区浏览**：自动读取 VS Code 的 workspaceStorage，列出最近打开的工作区；选择后列出其中文件（自动排除 node_modules/.git 等目录与二进制文件）。
- **发送文件给 DSH**：把文件作为**原文件附件**投递给**当前正在打开的对话**（不是首个会话——曾误投后台子代理会话），DSH 直接收到文件本体。
  - 对普通会话走官方附件暂存协议（fileUploads + receiptId），文件以真正附件形式到达；
  - 对由子代理路由持有的会话（官方守卫拒绝附件），文本文件自动降级为文本内容并明确说明。
- **文件选择与拖拽**：面板「选择文件…」可任选本机任意位置的文件（多选）；文件拖进面板进入「暂存区」，可选择**发送给 dsh** / **在工作台编辑** / 移除（参考微信/QQ 的交互）。
- **悬浮工作台**：一个可拖到任意位置的编辑卡片（类似 VS Code 编辑页）：
  - Word/WPS 式**多文档标签**，可拖动排序，关闭时询问是否保存；
  - 任意边界/角**缩放**，字号可输入数值（10–40）；
  - **语法着色**（VS Code Dark+ 配色）：Python / JavaScript / TypeScript / C / C++，自动检测（扩展名 + 内容启发式），也可手动选择；
  - 括号/引号自动配对、自动缩进；
  - 保存回磁盘（fs.writeText）；「发送给 DSH」把**编辑后的内容**作为文件附件发出；
  - 「自动同步」：fs.watch 监听文件变化（1.5s 防抖），保存即自动把**改动后的文件**发给你指定的对话——边编辑代码边与 DSH 对话。

## 安装

1. 获取插件目录（二选一）：

```powershell
git clone https://github.com/wenjun81/dsh-vscode
# 或下载源码 zip 解压
```

2. 把它安装进 DSH 的 profile（例如桌面 profile 目录 `%USERPROFILE%\.dsh\profiles\desktop`）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install <dsh-vscode 目录的绝对路径>
```

3. 在 profile 的 `package.json` 中把 bundle 加进启用列表：

```json
{
  "dependencies": { "dsh-vscode": "<上一步安装出的版本或链接>" },
  "dsh": { "profile": { "bundles": ["dsh-vscode"] } }
}
```

4. 在 DSH 插件管理器中启用「dsh-vscode」，刷新页面，左侧边栏出现「VScode」入口。

## 配置

在 profile 的 `cordis.patch.yml` 中给本 bundle 的 `config` 行传值（全部可选，均有默认值）：

```yaml
- insert:
    - id: dsh-vscode
      name: 'dsh-vscode'
      config:
        # 自定义 VS Code 可执行文件路径；Windows 上也可以是 .lnk 快捷方式。空 = 自动探测。
        vscodePath: ''
        # 诊断日志开关（启动/投递探针写系统临时目录）。默认关闭，不写任何文件。
        probeEnabled: false
        # 探针日志目录。空 = 系统临时目录下的 dsh-vscode。
        probeDir: ''
        # Windows：优先尝试桌面的 Visual Studio Code.lnk（explorer.exe 打开 = 等价双击）。
        desktopShortcut: true
```

## 隐私声明

- 本插件**不采集、不存储、不传输**任何使用数据；无遥测、无网络请求（除 DSH 自身 RPC）。
- 插件只做三件事：读写你指定的本地文件、启动 VS Code、通过 DSH 官方服务把文件投递给你当前打开的对话。
- 诊断探针**默认关闭**；开启后日志只写本机（系统临时目录），含操作结果与文件路径，供排查用，请自行注意其中内容。
- 全部行为可在源码中审计（`index.js` 宿主半体 / `client.js` 客户端半体）。

## 平台支持

- **Windows**：已实机验证（含桌面快捷方式启动、附件投递、工作台全功能）。
- **macOS / Linux**：探测链与路径已按平台适配（`/Applications/Visual Studio Code.app`、`~/.config/Code` 等），代码含平台分支，但作者暂无条件实机验证——**实验性支持**，欢迎反馈。

## License

MIT。图标为黑白双 chevron 原创设计，与 VS Code 官方商标不同，仅用于指代本插件的功能对象。

---

## dsh-vscode (English)

A DeepSeek Harness sidebar plugin that bridges VS Code into your DSH conversation.

- One-click launch of VS Code (auto-detected, or set `config.vscodePath`), open files at a line.
- Browse VS Code workspaces and their files from the sidebar panel.
- Send files to **the conversation you are currently viewing** as real attachments (official fileUploads/receiptId protocol); subagent-owned sessions fall back to text with a clear notice.
- Pick files from any folder, or drag & drop into a staging area (send / edit / remove).
- Floating multi-tab **workbench**: Word-style tabs with drag reorder and save prompts, resizable from any edge, syntax highlighting (Python / JavaScript / TypeScript / C / C++, VS Code Dark+ palette), bracket auto-pairing, editable font size, save-to-disk, send-edited-file-as-attachment, and file-watch auto-sync into your conversation.

Privacy: no telemetry, no data collection, no network calls beyond DSH's own RPC. Diagnostic probes are opt-in (`probeEnabled`) and write locally to a temp directory.

Platforms: Windows is verified. macOS/Linux detection is implemented but not yet verified on real hardware — experimental.

License: MIT.
