// dsh-vscode — Host half
// 职责：启动 VS Code、探测工作区、列出文件、把文件（附件）投递给 DSH 当前对话、工作台文件读写与自动同步。
// 客户端 ↔ 宿主通信：connection.rpc（通道 '/vscode-sidebar'）。
// 隐私声明：本插件不采集任何数据；诊断探针默认关闭（config.probeEnabled=false，日志写系统临时目录）。
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';

const RPC_CHANNEL = '/vscode-sidebar';
const MAX_SEND_CHARS = 200000;
const MAX_FILES = 300;
const MAX_DEPTH = 8;
const MAX_ATTACH_BYTES = 50 * 1024 * 1024; // 原文件附件上限 50 MB

// 配置（零依赖，手工归一化）：用户在 profile 的 cordis.patch.yml 中给本 bundle 的 config 行传值。
// 示例：config: { probeEnabled: true, vscodePath: 'D:\\VSCode\\Code.exe' }
const DEFAULT_CONFIG = {
  vscodePath: '',        // 自定义 VS Code 可执行文件路径（Windows 可为 .lnk 快捷方式）；空 = 自动探测
  probeEnabled: false,   // 诊断日志开关，默认关闭（不写任何文件）
  probeDir: '',          // 探针日志目录；空 = 系统临时目录下的 dsh-vscode
  desktopShortcut: true, // Windows：优先尝试桌面的 Visual Studio Code.lnk（explorer.exe 打开 = 等价双击）
};
function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  if (raw && typeof raw === 'object') {
    if (typeof raw.vscodePath === 'string' && raw.vscodePath) cfg.vscodePath = raw.vscodePath;
    if (typeof raw.probeEnabled === 'boolean') cfg.probeEnabled = raw.probeEnabled;
    if (typeof raw.probeDir === 'string' && raw.probeDir) cfg.probeDir = raw.probeDir;
    if (typeof raw.desktopShortcut === 'boolean') cfg.desktopShortcut = raw.desktopShortcut;
  }
  return cfg;
}
let ACTIVE_CFG = DEFAULT_CONFIG;
function probeDir() {
  if (ACTIVE_CFG.probeDir) return ACTIVE_CFG.probeDir;
  try { return path.join(os.tmpdir(), 'dsh-vscode'); } catch (e) { return undefined; }
}
function probeFile(name) {
  const dir = probeDir();
  if (!dir) return undefined;
  try { mkdirSync(dir, { recursive: true }); } catch (e) { return undefined; }
  return path.join(dir, name);
}
function logSpawn(line) {
  if (!ACTIVE_CFG.probeEnabled) return;
  const f = probeFile('spawn-probe.log');
  if (!f) return;
  try { appendFileSync(f, new Date().toISOString() + ' ' + line + '\n'); } catch (e) { /* ignore */ }
}
function desktopLnkPath() {
  try { return path.join(os.homedir(), 'Desktop', 'Visual Studio Code.lnk'); } catch (e) { return undefined; }
}

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.idea', '.svn', '.hg', '.cache', '.turbo',
  'dist', 'out', 'build', 'target', 'coverage', '__pycache__', '.venv', 'venv', '.next', '.nuxt',
]);
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'tif', 'tiff', 'psd', 'pdf',
  'zip', 'gz', 'tgz', '7z', 'rar', 'tar', 'xz', 'exe', 'msi', 'dll', 'so', 'dylib',
  'obj', 'o', 'a', 'class', 'jar', 'war', 'wasm', 'ttf', 'otf', 'woff', 'woff2',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wmv', 'flac', 'wav', 'ogg',
  'db', 'sqlite', 'sqlite3', 'pyc', 'pyo', 'lnk', 'bin', 'dat', 'iso', 'img', 'lock',
]);

export const name = 'dsh-vscode';
export const inject = ['subprocess', 'sessionController', 'fs', 'subagents', 'attachments', 'fileUploads'];

function appData() {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.APPDATA) return process.env.APPDATA;
  } catch (e) { /* ignore */ }
  try { return path.join(os.homedir(), 'AppData', 'Roaming'); } catch (e) { return undefined; }
}

function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.toLowerCase().startsWith('file://')) return undefined;
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  } catch (e) { return undefined; }
}

async function detectWorkspaces(fs) {
  const out = [];
  const base = appData();
  let home;
  try { home = os.homedir(); } catch (e) { home = undefined; }
  let storageRoot;
  if (process.platform === 'darwin' && home) {
    storageRoot = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
  } else if (process.platform === 'linux' && home) {
    storageRoot = path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
  } else {
    if (!base) return out;
    storageRoot = path.join(base, 'Code', 'User', 'workspaceStorage');
  }
  let baseTarget;
  try { baseTarget = await fs.resolve(storageRoot); } catch (e) { return out; }
  let info;
  try { info = await fs.stat(baseTarget); } catch (e) { return out; }
  if (!info || info.type !== 'directory') return out;
  let entries;
  try { entries = await fs.listDir(baseTarget); } catch (e) { return out; }
  for (const entry of entries) {
    if (!entry || entry.type !== 'directory') continue;
    const wsJsonPath = path.join(storageRoot, entry.name, 'workspace.json');
    let target;
    try { target = await fs.resolve(wsJsonPath); } catch (e) { continue; }
    let wsInfo;
    try { wsInfo = await fs.stat(target); } catch (e) { continue; }
    if (!wsInfo || wsInfo.type !== 'file') continue;
    let text;
    try { text = await fs.readText(target); } catch (e) { continue; }
    try {
      const parsed = JSON.parse(text);
      const p = fileUriToPath(parsed && (parsed.folder || parsed.workspace));
      if (p && !out.some((w) => w.path === p)) out.push({ path: p, label: path.basename(p) || p });
    } catch (e) { /* ignore */ }
  }
  return out;
}

async function walk(fs, dirPath, rel, depth, acc) {
  if (acc.files.length >= MAX_FILES || depth > MAX_DEPTH) { acc.truncated = true; return; }
  let target;
  try { target = await fs.resolve(dirPath); } catch (e) { return; }
  let entries;
  try { entries = await fs.listDir(target); } catch (e) { return; }
  for (const entry of entries) {
    if (acc.files.length >= MAX_FILES) { acc.truncated = true; return; }
    if (!entry || typeof entry.name !== 'string') continue;
    const name = entry.name;
    if (entry.type === 'directory') {
      if (EXCLUDED_DIRS.has(name)) continue;
      const childDir = (entry.target && entry.target.displayPath) || path.join(dirPath, name);
      await walk(fs, childDir, rel ? rel + '/' + name : name, depth + 1, acc);
    } else if (entry.type === 'file') {
      const idx = name.lastIndexOf('.');
      const ext = idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
      if (BINARY_EXT.has(ext)) continue;
      acc.files.push({
        path: (entry.target && entry.target.displayPath) || path.join(dirPath, name),
        name,
        rel: rel ? rel + '/' + name : name,
        size: entry.size,
      });
    }
  }
}

function buildPrompt(filePath, text, truncated) {
  const name = path.basename(filePath);
  return [
    '【DSH 侧边栏「VScode」提交的文件，请分析并回复】',
    '文件路径：' + filePath,
    '文件名：' + name,
    '',
    truncated
      ? '提示：文件较大，内容已截断至前 ' + MAX_SEND_CHARS + ' 字符。'
      : '文件内容（完整）：',
    '<<<<< 文件开始：' + name + ' >>>>>',
    text,
    '<<<<< 文件结束 >>>>>',
  ].join('\n');
}

async function findVsCode(subprocess, signal) {
  const base = appData();
  const candidates = [];
  if (process.platform === 'win32') {
    if (base) candidates.push(path.join(base, '..', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'));
    candidates.push('C:\\Program Files\\Microsoft VS Code\\Code.exe');
    candidates.push('C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  } else {
    candidates.push('/usr/bin/code');
    candidates.push('/usr/local/bin/code');
    try { candidates.push(path.join(os.homedir(), '.local', 'bin', 'code')); } catch (e) { /* ignore */ }
  }
  for (const c of candidates) {
    try {
      const resolved = await subprocess.resolveExecutable(c, undefined, signal);
      if (resolved) return resolved;
    } catch (e) { /* next */ }
  }
  try { return await subprocess.resolveExecutable('code', undefined, signal); } catch (e) { return undefined; }
}

// 解析投递目标会话。targetSessionId（客户端传来的当前对话 id）优先；缺省时退回「首个非 blank 会话」。
async function resolveTargetSession(sessionController, targetSessionId, signal) {
  if (targetSessionId) {
    let list;
    try { list = await sessionController.list({}, signal); } catch (e) { list = undefined; }
    const items = (list && list.items) || [];
    let chosen = items.find((s) => s && s.sessionId === targetSessionId && !s.blank)
      || items.find((s) => s && s.sessionId === targetSessionId);
    if (!chosen) {
      // 目标可能不在 list 首页：尝试 inspect 取 header（含 origin/parentSession）。
      try {
        const insp = await sessionController.inspect(targetSessionId, signal);
        const h = insp && insp.meta;
        if (h && h.id) chosen = { sessionId: h.id, origin: h.origin, parentSessionId: h.parentSession, blank: false };
      } catch (e) { chosen = undefined; }
    }
    if (!chosen || !chosen.sessionId) {
      return { ok: false, error: { code: 'target-not-found', message: '目标会话不可用（可能已关闭）：' + targetSessionId, details: {} } };
    }
    return { ok: true, chosen };
  }
  let list;
  try { list = await sessionController.list({}, signal); } catch (e) {
    return { ok: false, error: { code: 'list-failed', message: String((e && e.message) || e), details: {} } };
  }
  const items = (list && list.items) || [];
  const chosen = items.find((s) => s && !s.blank) || items[0];
  if (!chosen || !chosen.sessionId) {
    return { ok: false, error: { code: 'no-session', message: '当前没有可用的 DSH 会话', details: {} } };
  }
  return { ok: true, chosen };
}

function isSubagentSession(chosen) {
  return !!(chosen && chosen.origin === 'subagent' && chosen.parentSessionId);
}

// 把文本提示投递进已选定的会话。
// 普通会话 → sessionController.prompt；
// 由 subagent routing 持有的会话（如 Agent Teams 的队内会话，origin==='subagent'）→ subagents.prompt
// （sessionController 对该类会话一律拒绝："session ... is owned by subagent routing"，守卫无豁免，
//  其受认可的投递路径即 subagents 服务的 @Remote('prompt')——与 GUI 客户端 Session.prompt() 的 subagent 分支一致）。
async function deliverTextToChosen(sessionController, subagents, chosen, promptText, signal) {
  const requestId = randomUUID();
  const content = [{ type: 'text', text: promptText }];
  if (isSubagentSession(chosen)) {
    if (!subagents || typeof subagents.prompt !== 'function') {
      return { ok: false, error: { code: 'no-subagents-service', message: '目标会话由子代理路由持有，但 subagents 服务不可用', details: {} } };
    }
    try {
      const receipt = await subagents.prompt({
        requestId,
        parentSessionId: chosen.parentSessionId,
        childSessionId: chosen.sessionId,
        mode: 'continuable',
        delivery: 'queue',
        content,
      }, signal);
      return {
        ok: true,
        value: {
          accepted: true,
          sessionId: chosen.sessionId,
          deliveredVia: 'subagent',
          messageId: receipt && receipt.messageId,
        },
      };
    } catch (e) {
      return { ok: false, error: { code: 'subagent-delivery-failed', message: '发送失败：' + String((e && e.message) || e), details: {} } };
    }
  }
  try {
    const result = await sessionController.prompt({ requestId, sessionId: chosen.sessionId, mode: 'queue', content }, signal);
    return { ok: true, value: { accepted: !!(result && result.accepted), sessionId: chosen.sessionId, deliveredVia: 'session' } };
  } catch (e) {
    return { ok: false, error: { code: 'prompt-failed', message: '发送失败：' + String((e && e.message) || e), details: {} } };
  }
}

async function deliverPrompt(sessionController, subagents, promptText, signal, targetSessionId) {
  const resolved = await resolveTargetSession(sessionController, targetSessionId, signal);
  if (!resolved.ok) return resolved;
  return deliverTextToChosen(sessionController, subagents, resolved.chosen, promptText, signal);
}

// v0.9.2：把【原文件字节】作为附件投递给 chosen 会话（供「发送给 DSH」与「自动同步」共用）。
// subagent 持有的会话不支持附件：文本文件自动降级为文本内容，二进制文件明确报错。
async function deliverAttachmentBytes(sessionController, subagents, attachments, fileUploads, chosen, bytes, name, signal) {
  if (isSubagentSession(chosen)) {
    const isBinary = looksBinary(bytes);
    let text = '';
    if (!isBinary) { try { text = Buffer.from(bytes).toString('utf8'); } catch (e) { text = ''; } }
    if (!text) {
      return { ok: false, error: { code: 'subagent-file-unsupported', message: '当前对话由子代理路由持有，不支持发送原文件附件；请切换回普通对话后重试', details: {} } };
    }
    let finalText = text;
    let truncated = false;
    if (finalText.length > MAX_SEND_CHARS) { finalText = finalText.slice(0, MAX_SEND_CHARS); truncated = true; }
    const promptText = [
      '【DSH 侧边栏「VScode」提交的文件，请分析并回复】',
      '文件名：' + name,
      '说明：当前对话由子代理路由持有，不支持附件，以下为文件文本内容' + (truncated ? '（已截断至前 ' + MAX_SEND_CHARS + ' 字符）' : '（完整）') + '。',
      '<<<<< 文件开始：' + name + ' >>>>>',
      finalText,
      '<<<<< 文件结束 >>>>>',
    ].join('\n');
    const result = await deliverTextToChosen(sessionController, subagents, chosen, promptText, signal);
    if (result && result.ok && result.value) result.value.viaAttachment = false;
    return result;
  }

  // 官方投递协议（dsh-api-session-controller resolvePromptFileReceipts）：prompt 的 file 块必须携带
  // receiptId，且该 receipt 必须由 fileUploads.uploadStream({sessionId}) 为同一会话暂存（staged）。
  // 直接 attachments.saveFile 的引用不带会话暂存 → 必被拒 "File was not uploaded for this session."。
  let receiptId;
  let fileRef;
  if (fileUploads && typeof fileUploads.uploadStream === 'function') {
    try {
      const chunks = (async function* () { yield bytes; })();
      const upload = await fileUploads.uploadStream({ sessionId: chosen.sessionId, data: chunks, name });
      receiptId = upload && upload.receiptId;
      fileRef = upload && upload.file;
      logSpawn('attachment uploadStream-ok receiptId=' + (receiptId || '(none)') + ' attachmentId=' + (fileRef && fileRef.attachmentId) + ' bytes=' + (fileRef && fileRef.bytes));
    } catch (e) {
      logSpawn('attachment uploadStream-failed err=' + String((e && e.message) || e) + ' -> trying saveFile');
    }
  } else {
    logSpawn('attachment uploadStream unavailable');
  }
  if (!receiptId && attachments && typeof attachments.saveFile === 'function') {
    try { fileRef = await attachments.saveFile({ data: bytes, name }); } catch (e) {
      logSpawn('attachment saveFile-failed err=' + String((e && e.message) || e));
    }
  }
  if (!receiptId && !fileRef) {
    return { ok: false, error: { code: 'save-file-failed', message: '附件保存失败：uploadStream 与 saveFile 均不可用（详见探针日志）', details: {} } };
  }
  logSpawn('attachment ref-ok receiptId=' + (receiptId || '(none)') + ' attachmentId=' + (fileRef && fileRef.attachmentId) + ' bytes=' + (fileRef && fileRef.bytes));
  const requestId = randomUUID();
  const intro = '【DSH 侧边栏「VScode」提交的原文件，请分析并回复】\n文件名：' + name + '\n大小：' + ((fileRef && fileRef.bytes) || bytes.length) + ' 字节';
  const content = receiptId
    ? [{ type: 'file', receiptId }, { type: 'text', text: intro }]
    : [{ type: 'file', attachment: fileRef }, { type: 'text', text: intro }];
  try {
    const result = await sessionController.prompt({ requestId, sessionId: chosen.sessionId, mode: 'queue', content }, signal);
    logSpawn('attachment prompt-ok accepted=' + !!(result && result.accepted));
    return {
      ok: true,
      value: {
        accepted: !!(result && result.accepted),
        sessionId: chosen.sessionId,
        deliveredVia: 'session',
        viaAttachment: true,
        attachmentId: fileRef && fileRef.attachmentId,
        name: fileRef && fileRef.name,
        bytes: fileRef && fileRef.bytes,
      },
    };
  } catch (e) {
    logSpawn('attachment prompt-failed err=' + String((e && e.message) || e) + ' -> trying text-fallback');
    let t2 = '';
    try { t2 = Buffer.from(bytes).toString('utf8'); } catch (e2) { t2 = ''; }
    if (t2) {
      let finalText = t2;
      let truncated = false;
      if (finalText.length > MAX_SEND_CHARS) { finalText = finalText.slice(0, MAX_SEND_CHARS); truncated = true; }
      const promptText = [
        '【DSH 侧边栏「VScode」提交的文件，请分析并回复】',
        '文件名：' + name,
        '说明：附件投递失败（' + String((e && e.message) || e) + '），已降级为文本内容' + (truncated ? '（截断至前 ' + MAX_SEND_CHARS + ' 字符）' : '（完整）') + '。',
        '<<<<< 文件开始：' + name + ' >>>>>',
        finalText,
        '<<<<< 文件结束 >>>>>',
      ].join('\n');
      const res2 = await deliverTextToChosen(sessionController, subagents, chosen, promptText, signal);
      logSpawn('attachment text-fallback ' + (res2 && res2.ok ? 'ok' : 'failed err=' + String((res2 && res2.error && res2.error.message) || res2)));
      if (res2 && res2.ok && res2.value) res2.value.viaAttachment = false;
      return res2;
    }
    return { ok: false, error: { code: 'prompt-failed', message: '发送失败：' + String((e && e.message) || e), details: {} } };
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function createHandler(ctx) {
  const { fs, subprocess, sessionController } = ctx;
  const subagents = ctx.subagents || (typeof ctx.get === 'function' ? ctx.get('subagents') : undefined);
  const attachments = ctx.attachments || (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined);
  const fileUploads = ctx.fileUploads || (typeof ctx.get === 'function' ? ctx.get('fileUploads') : undefined);
  // 工作台「自动同步」：path → { close, timer, sessionId, lastText }
  const syncs = new Map();
  return async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'openVsCode') {
        const workspace = payload && typeof payload.workspace === 'string' && payload.workspace ? payload.workspace : undefined;
        // 子进程环境：宿主沙箱环境带 ELECTRON_RUN_AS_NODE=1，Electron 系程序（VS Code）会以 node 模式秒退（exit=1 实证）。
        // 传给子进程前必须清掉该变量（覆盖为空串=禁用 node 模式）。
        const spawnEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '' };
        // 1) config.vscodePath 优先（Windows 上可为 .lnk → explorer.exe 打开，等价双击；spawn 直接启 .lnk 会失败）。
        const custom = ACTIVE_CFG.vscodePath;
        if (custom) {
          const isLnk = process.platform === 'win32' && custom.toLowerCase().endsWith('.lnk');
          const spec = {
            argv: isLnk ? ['explorer.exe', custom] : (workspace ? [custom, workspace] : [custom]),
            cwd: path.dirname(custom),
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 3000,
            env: spawnEnv,
          };
          try {
            const handle = subprocess.spawn(spec);
            logSpawn('openVsCode custom-spawn-ok ' + (isLnk ? 'lnk=' : 'exe=') + custom);
            handle.done.then(
              (r) => logSpawn('openVsCode custom-done exit=' + (r && r.exitCode) + ' signal=' + (r && r.signal)),
              (e) => logSpawn('openVsCode custom-done-rejected err=' + String((e && e.message) || e))
            );
            handle.done.catch(() => {});
            return { ok: true, value: { launched: true, exe: custom, kind: isLnk ? 'shortcut' : 'custom', workspace: null } };
          } catch (e) {
            logSpawn('openVsCode custom-spawn-THROW err=' + String((e && e.message) || e) + ' -> fallback');
          }
        }
        // 2) Windows：桌面快捷方式（fs.stat 直接吃裸路径会被按相对路径解析而失败——必须先 fs.resolve()）。
        const lnk = desktopLnkPath();
        let lnkOk = false;
        if (process.platform === 'win32' && ACTIVE_CFG.desktopShortcut && lnk) {
          try {
            const lnkTarget = await fs.resolve(lnk);
            const info = await fs.stat(lnkTarget);
            lnkOk = !!(info && info.type === 'file');
          } catch (e) {
            logSpawn('openVsCode lnk-stat-THROW err=' + String((e && e.message) || e));
            lnkOk = false;
          }
        }
        if (lnkOk) {
          const spec = {
            argv: ['explorer.exe', lnk],
            cwd: path.dirname(lnk),
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 3000,
            env: spawnEnv,
          };
          try {
            const handle = subprocess.spawn(spec);
            logSpawn('openVsCode lnk-spawn-ok lnk=' + lnk);
            handle.done.then(
              (r) => logSpawn('openVsCode lnk-done exit=' + (r && r.exitCode) + ' signal=' + (r && r.signal)),
              (e) => logSpawn('openVsCode lnk-done-rejected err=' + String((e && e.message) || e))
            );
            handle.done.catch(() => {});
            return { ok: true, value: { launched: true, exe: lnk, kind: 'shortcut', workspace: null } };
          } catch (e) {
            logSpawn('openVsCode lnk-spawn-THROW err=' + String((e && e.message) || e) + ' -> fallback to exe');
          }
        } else if (process.platform === 'win32' && ACTIVE_CFG.desktopShortcut && lnk) {
          logSpawn('openVsCode lnk-missing path=' + lnk);
        }
        const exe = await findVsCode(subprocess, signal);
        if (!exe) {
          return { ok: false, error: { code: 'not-found', message: '找不到 VS Code（快捷方式与 Code.exe 均不可用）：请手动打开 VS Code，或告知其安装路径', details: {} } };
        }
        const spec = {
          argv: workspace ? [exe, workspace] : [exe],
          cwd: path.dirname(exe),
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 3000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
        };
        let handle;
        try {
          handle = subprocess.spawn(spec);
        } catch (e) {
          logSpawn('openVsCode spawn-THROW exe=' + exe + ' err=' + String((e && e.message) || e));
          return { ok: false, error: { code: 'spawn-failed', message: '启动 VS Code 失败：' + String((e && e.message) || e), details: {} } };
        }
        // VS Code 常驻运行，不等待退出；仅吞掉结局避免 unhandled rejection。
        logSpawn('openVsCode spawn-ok exe=' + exe + ' workspace=' + (workspace || '(none)'));
        handle.done.then(
          (r) => logSpawn('openVsCode done exe=' + exe + ' exit=' + (r && r.exitCode) + ' signal=' + (r && r.signal)),
          (e) => logSpawn('openVsCode done-rejected exe=' + exe + ' err=' + String((e && e.message) || e))
        );
        handle.done.catch(() => {});
        return { ok: true, value: { launched: true, exe, workspace: workspace || null } };
      }

      if (endpoint === 'openFileInVsCode') {
        const filePath = payload && typeof payload.path === 'string' && payload.path ? payload.path : undefined;
        if (!filePath) return { ok: false, error: { code: 'bad-request', message: '缺少文件路径', details: {} } };
        let exe = ACTIVE_CFG.vscodePath;
        if (exe && process.platform === 'win32' && exe.toLowerCase().endsWith('.lnk')) exe = undefined; // .lnk 不能直接 spawn 打开文件
        if (!exe) exe = await findVsCode(subprocess, signal);
        if (!exe) {
          return { ok: false, error: { code: 'not-found', message: '找不到 VS Code（Code.exe）：请手动打开 VS Code，或告知其安装路径', details: {} } };
        }
        let target;
        try { target = await fs.resolve(filePath); } catch (e) {
          return { ok: false, error: { code: 'resolve-failed', message: '无法解析路径：' + String((e && e.message) || e), details: {} } };
        }
        let info;
        try { info = await fs.stat(target); } catch (e) { info = undefined; }
        if (!info || info.type !== 'file') {
          return { ok: false, error: { code: 'not-found', message: '文件不存在：' + filePath, details: {} } };
        }
        const spec = {
          argv: [exe, '-r', '-g', filePath + ':1'],
          cwd: path.dirname(exe),
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 3000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
        };
        let handle2;
        try {
          handle2 = subprocess.spawn(spec);
        } catch (e) {
          logSpawn('openFileInVsCode spawn-THROW exe=' + exe + ' file=' + filePath + ' err=' + String((e && e.message) || e));
          return { ok: false, error: { code: 'spawn-failed', message: '启动 VS Code 失败：' + String((e && e.message) || e), details: {} } };
        }
        logSpawn('openFileInVsCode spawn-ok exe=' + exe + ' file=' + filePath);
        handle2.done.then(
          (r) => logSpawn('openFileInVsCode done exe=' + exe + ' exit=' + (r && r.exitCode) + ' signal=' + (r && r.signal)),
          (e) => logSpawn('openFileInVsCode done-rejected exe=' + exe + ' err=' + String((e && e.message) || e))
        );
        handle2.done.catch(() => {});
        return { ok: true, value: { launched: true, file: filePath } };
      }

      if (endpoint === 'detectWorkspace') {
        return { ok: true, value: { workspaces: await detectWorkspaces(fs) } };
      }

      if (endpoint === 'listWorkspaceFiles') {
        const ws = payload && typeof payload.workspace === 'string' && payload.workspace ? payload.workspace : undefined;
        if (!ws) return { ok: false, error: { code: 'bad-request', message: '缺少 workspace 路径', details: {} } };
        const acc = { files: [], truncated: false };
        await walk(fs, ws, '', 0, acc);
        acc.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        return { ok: true, value: { workspace: ws, files: acc.files, truncated: acc.truncated } };
      }

      if (endpoint === 'sendFileToDsh') {
        const filePath = payload && typeof payload.path === 'string' && payload.path ? payload.path : undefined;
        if (!filePath) return { ok: false, error: { code: 'bad-request', message: '缺少文件路径', details: {} } };
        const ext = path.extname(filePath).slice(1).toLowerCase();
        if (BINARY_EXT.has(ext)) {
          return { ok: false, error: { code: 'unsupported', message: '不支持发送该文件类型：.' + ext, details: {} } };
        }
        let target;
        try { target = await fs.resolve(filePath); } catch (e) {
          return { ok: false, error: { code: 'resolve-failed', message: '无法解析路径：' + String((e && e.message) || e), details: {} } };
        }
        let text;
        try { text = await fs.readText(target, signal); } catch (e) {
          return { ok: false, error: { code: 'read-failed', message: '读取失败：' + String((e && e.message) || e), details: {} } };
        }
        let truncated = false;
        if (text.length > MAX_SEND_CHARS) { text = text.slice(0, MAX_SEND_CHARS); truncated = true; }
        const sessionId = payload && typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
        return deliverPrompt(sessionController, subagents, buildPrompt(filePath, text, truncated), signal, sessionId);
      }

      if (endpoint === 'sendFileAttachmentToDsh') {
        // 发送【原文件】（作为附件，而非文本内容）：读原始字节 → attachments.saveFile → prompt 携带 file 块。
        // 普通会话走 sessionController.prompt；subagent 持有的会话不支持附件（官方同款限制），
        // 文本类文件自动退化为发送文本内容，二进制文件明确报错。
        const sessionId = payload && typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
        let bytes;
        let name;
        if (payload && typeof payload.path === 'string' && payload.path) {
          let target;
          try { target = await fs.resolve(payload.path); } catch (e) {
            return { ok: false, error: { code: 'resolve-failed', message: '无法解析路径：' + String((e && e.message) || e), details: {} } };
          }
          let info;
          try { info = await fs.stat(target); } catch (e) { info = undefined; }
          if (!info || info.type !== 'file') {
            return { ok: false, error: { code: 'not-found', message: '文件不存在：' + payload.path, details: {} } };
          }
          if (typeof info.size === 'number' && info.size > MAX_ATTACH_BYTES) {
            return { ok: false, error: { code: 'too-large', message: '文件过大（' + Math.round(info.size / 1048576) + ' MB，上限 ' + (MAX_ATTACH_BYTES / 1048576) + ' MB）', details: {} } };
          }
          try { bytes = await fs.readBytes(target, signal, MAX_ATTACH_BYTES); } catch (e) {
            return { ok: false, error: { code: 'read-failed', message: '读取失败：' + String((e && e.message) || e), details: {} } };
          }
          name = path.basename(payload.path);
        } else if (payload && typeof payload.data === 'string' && payload.data) {
          try { bytes = Buffer.from(payload.data, 'base64'); } catch (e) {
            return { ok: false, error: { code: 'bad-request', message: '文件数据不是有效的 base64', details: {} } };
          }
          if (bytes.length > MAX_ATTACH_BYTES) {
            return { ok: false, error: { code: 'too-large', message: '文件过大（上限 ' + (MAX_ATTACH_BYTES / 1048576) + ' MB）', details: {} } };
          }
          name = (payload && typeof payload.name === 'string' && payload.name) || '未命名文件';
        } else {
          return { ok: false, error: { code: 'bad-request', message: '缺少文件路径或文件数据', details: {} } };
        }
        if (!bytes || !bytes.length) {
          return { ok: false, error: { code: 'empty-file', message: '文件内容为空（0 字节），未发送', details: {} } };
        }
        logSpawn('sendFileAttachment src=' + (payload && payload.path ? 'path:' + payload.path : 'data') + ' name=' + name + ' bytes=' + bytes.length + ' session=' + (sessionId || '(none)'));

        const resolved = await resolveTargetSession(sessionController, sessionId, signal);
        if (!resolved.ok) {
          logSpawn('sendFileAttachment resolve-failed err=' + String((resolved.error && resolved.error.message) || resolved.error));
          return resolved;
        }
        const chosen = resolved.chosen;
        logSpawn('sendFileAttachment target=' + chosen.sessionId + ' origin=' + (chosen.origin || 'plain') + ' parent=' + (chosen.parentSessionId || '(none)'));

        return deliverAttachmentBytes(sessionController, subagents, attachments, fileUploads, chosen, bytes, name, signal);
      }

      if (endpoint === 'sendTextToDsh') {
        const fileName = (payload && typeof payload.name === 'string' && payload.name) || '拖拽文件.txt';
        const text = payload && typeof payload.text === 'string' ? payload.text : undefined;
        if (text === undefined) return { ok: false, error: { code: 'bad-request', message: '缺少文本内容', details: {} } };
        let finalText = text;
        let truncated = false;
        if (finalText.length > MAX_SEND_CHARS) { finalText = finalText.slice(0, MAX_SEND_CHARS); truncated = true; }
        const sessionId = payload && typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
        return deliverPrompt(sessionController, subagents, buildPrompt(fileName, finalText, truncated), signal, sessionId);
      }

      if (endpoint === 'listSessions') {
        try {
          const list = await sessionController.list({}, signal);
          const items = (list && list.items) || [];
          return {
            ok: true,
            value: {
              sessions: items.slice(0, 10).map((s) => ({
                sessionId: s.sessionId,
                running: !!s.running,
                blank: !!s.blank,
                updatedAt: s.updatedAt,
                cwd: s.cwd,
                origin: s.origin || null,
                parentSessionId: s.parentSessionId || null,
              })),
            },
          };
        } catch (e) {
          return { ok: false, error: { code: 'list-failed', message: String((e && e.message) || e), details: {} } };
        }
      }

      if (endpoint === 'clientLoaded') {
        if (ACTIVE_CFG.probeEnabled) {
          try {
            const href = (payload && typeof payload.href === 'string' && payload.href) || '';
            const now = (payload && typeof payload.now === 'number' && payload.now) || 0;
            const version = (payload && typeof payload.version === 'string' && payload.version) || 'unknown';
            const portal = payload && typeof payload.portal === 'boolean' ? payload.portal : null;
            const f = probeFile('client-loaded.log');
            if (f) appendFileSync(f, 'client half loaded at ' + new Date().toISOString() + ' v=' + version + ' pageNow=' + String(now) + ' href=' + href + ' portal=' + String(portal) + '\n');
          } catch (e) { /* ignore */ }
        }
        return { ok: true, value: { loaded: true } };
      }

      if (endpoint === 'logClient') {
        try {
          const msg = (payload && typeof payload.msg === 'string' && payload.msg) || '(empty)';
          logSpawn('client ' + msg.slice(0, 2000));
        } catch (e) { /* ignore */ }
        return { ok: true, value: { logged: true } };
      }

      if (endpoint === 'readFileForEdit') {
        // 工作台：读取文件全文到编辑器。
        const filePath = payload && typeof payload.path === 'string' && payload.path ? payload.path : undefined;
        if (!filePath) return { ok: false, error: { code: 'bad-request', message: '缺少文件路径', details: {} } };
        let target;
        try { target = await fs.resolve(filePath); } catch (e) {
          return { ok: false, error: { code: 'resolve-failed', message: '无法解析路径：' + String((e && e.message) || e), details: {} } };
        }
        let info;
        try { info = await fs.stat(target); } catch (e) { info = undefined; }
        if (!info || info.type !== 'file') {
          return { ok: false, error: { code: 'not-found', message: '文件不存在：' + filePath, details: {} } };
        }
        try {
          const text = await fs.readText(target, signal);
          return { ok: true, value: { path: filePath, text, size: info.size } };
        } catch (e) {
          return { ok: false, error: { code: 'read-failed', message: '读取失败（可能是二进制文件）：' + String((e && e.message) || e), details: {} } };
        }
      }

      if (endpoint === 'writeFileFromPanel') {
        // 工作台：把编辑器内容写回磁盘。沙箱限制（如工作区外文件）会把拒绝原因如实带回。
        const filePath = payload && typeof payload.path === 'string' && payload.path ? payload.path : undefined;
        const content = payload && typeof payload.content === 'string' ? payload.content : undefined;
        if (!filePath) return { ok: false, error: { code: 'bad-request', message: '缺少文件路径', details: {} } };
        if (content === undefined) return { ok: false, error: { code: 'bad-request', message: '缺少文件内容', details: {} } };
        let target;
        try { target = await fs.resolve(filePath); } catch (e) {
          return { ok: false, error: { code: 'resolve-failed', message: '无法解析路径：' + String((e && e.message) || e), details: {} } };
        }
        try {
          const outcome = await fs.writeText(target, content);
          return { ok: true, value: { path: filePath, operation: outcome.operation } };
        } catch (e) {
          return { ok: false, error: { code: 'write-failed', message: '保存失败：' + String((e && e.message) || e), details: {} } };
        }
      }

      if (endpoint === 'syncStart') {
        // 工作台「同步实时解析」：watch 文件变化 → 防抖 1.5s → 读全文 → 投递给指定会话。
        const filePath = payload && typeof payload.path === 'string' && payload.path ? payload.path : undefined;
        const sessionId = payload && typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined;
        if (!filePath) return { ok: false, error: { code: 'bad-request', message: '缺少文件路径', details: {} } };
        if (syncs.has(filePath)) return { ok: true, value: { path: filePath, already: true } };
        let target;
        try { target = await fs.resolve(filePath); } catch (e) {
          return { ok: false, error: { code: 'resolve-failed', message: '无法解析路径：' + String((e && e.message) || e), details: {} } };
        }
        const entry = { close: null, timer: null, sessionId, lastText: '' };
        syncs.set(filePath, entry);
        const fire = async () => {
          try {
            let bytes;
            try { bytes = await fs.readBytes(target, undefined, MAX_ATTACH_BYTES); } catch (e) {
              logSpawn('syncStart read-bytes-failed path=' + filePath + ' err=' + String((e && e.message) || e));
              return;
            }
            if (!bytes || !bytes.length) return;
            const text = Buffer.from(bytes).toString('utf8');
            if (text === entry.lastText) return;
            entry.lastText = text;
            const resolved = await resolveTargetSession(sessionController, sessionId, signal);
            if (!resolved.ok) {
              logSpawn('syncStart resolve-failed err=' + String((resolved.error && resolved.error.message) || resolved.error));
              return;
            }
            const result = await deliverAttachmentBytes(sessionController, subagents, attachments, fileUploads, resolved.chosen, bytes, path.basename(filePath), signal);
            if (!result || !result.ok) logSpawn('syncStart send-failed path=' + filePath + ' err=' + ((result && result.error && result.error.message) || 'unknown'));
            else logSpawn('syncStart attachment-ok path=' + filePath + ' viaAttachment=' + !!(result.value && result.value.viaAttachment) + ' bytes=' + bytes.length);
          } catch (e) {
            logSpawn('syncStart read-failed path=' + filePath + ' err=' + String((e && e.message) || e));
          }
        };
        const onChanged = () => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(fire, 1500);
        };
        try {
          const controller = new AbortController();
          entry.close = await fs.watch(target, onChanged, controller.signal);
          logSpawn('syncStart ok path=' + filePath + ' session=' + (sessionId || '(none)'));
          return { ok: true, value: { path: filePath } };
        } catch (e) {
          syncs.delete(filePath);
          return { ok: false, error: { code: 'watch-failed', message: '无法监听文件：' + String((e && e.message) || e), details: {} } };
        }
      }

      if (endpoint === 'syncStop') {
        const filePath = payload && typeof payload.path === 'string' && payload.path ? payload.path : undefined;
        if (!filePath) return { ok: false, error: { code: 'bad-request', message: '缺少文件路径', details: {} } };
        const entry = syncs.get(filePath);
        if (entry) {
          if (entry.timer) clearTimeout(entry.timer);
          try { if (entry.close) await entry.close(); } catch (e) { /* ignore */ }
          syncs.delete(filePath);
          logSpawn('syncStop ok path=' + filePath);
        }
        return { ok: true, value: { stopped: true } };
      }

      if (endpoint === 'syncStatus') {
        return { ok: true, value: { syncs: Array.from(syncs.keys()) } };
      }

      return { ok: false, error: { code: 'not-found', message: 'unknown endpoint: ' + endpoint, details: {} } };
    } catch (e) {
      return { ok: false, error: { code: 'internal', message: String((e && e.message) || e).slice(0, 500), details: {} } };
    }
  };
}

export function apply(ctx, rawConfig) {
  ACTIVE_CFG = normalizeConfig(rawConfig);
  // connection 服务在桌面宿主必存在（已实测）；嵌套 inject 保证服务就绪后再注册，插件卸载时 effect 自动注销。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.root.connection;
    connectionCtx.effect(() => connection.rpc.handle(RPC_CHANNEL, createHandler(ctx)), 'vscode-sidebar: panel RPC channel');
  });
}

export default { name, inject, apply };
