// dsh-vscode — Client half
// 侧边栏「VScode」入口 + 主面板：打开 VS Code、选工作区、列文件、在 VS Code 中打开、发送原文件附件给当前对话、拖拽文件暂存、悬浮多标签工作台。
// 通信：ctx.get('connection').rpc.call('/vscode-sidebar', endpoint, payload)。
// 槽位注册必须携带 name 字段（register 选项的 name 是槽名，SlotRegistry 用它解析槽位声明——官方例子一律如此）。
// 样式禁用 CSS 变量：--dsw-alias-* 在插件 DOM 内不解析（background 声明被丢弃，按钮落回 UA 浅灰底 + 白字 = 隐形白图标），全部使用具体色值。
// 隐私声明：本插件不采集任何数据；clientLoaded 探针仅在宿主 config.probeEnabled=true 时才落盘（默认关闭）。
// 发送目标=「当前打开的对话」（uiSession 服务取会话 id 传给宿主精确投递），避免误投后台子代理会话。
window.__ModuleLoader__.load({
  id: '@wenjun81/dsh-vscode',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useMemo, useRef } = React;
    // v0.9.0：react-dom.createPortal 把工作台卡片/把手挂到 document.body，脱离主面板 DOM 树（避免被祖先层叠上下文困住），
    // 拖文件时才能真正盖过 DSH 应用级模糊投放遮罩；react-dom 不可用时退化为原位置渲染。
    // （保存本文件会触发客户端 HMR，重新执行 apply 并重发 clientLoaded 探针）
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch (e) { ReactDOM = null; }
    const canPortal = !!(ReactDOM && typeof ReactDOM.createPortal === 'function');
    function wrapOverlay(el) {
      return canPortal ? ReactDOM.createPortal(el, document.body) : el;
    }
    const CHANNEL = '/vscode-sidebar';
    const NS = 'vscode-sidebar';
    let rootCtx = null;
    // 当前打开的对话 id（uiSession 服务，与 dsh-mnemon 同款取法：adapter.current.getSnapshot().key）。
    // 面板被切走时 adapter 可能清空，这里保留最后一次见到的会话 id。
    const sessionIdRef = { current: undefined };
    function watchCurrentSession(ctx) {
      try {
        const uiSession = ctx && typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined;
        const adapter = uiSession && uiSession.adapter && uiSession.adapter.current;
        if (!adapter || typeof adapter.getSnapshot !== 'function') return;
        const update = () => {
          const snap = adapter.getSnapshot();
          const key = snap && snap.key;
          if (typeof key === 'string' && key) sessionIdRef.current = key;
        };
        update();
        if (typeof adapter.subscribe === 'function') adapter.subscribe(update);
      } catch (e) { /* ignore */ }
    }

    // 工作台（悬浮于对话之上，编辑代码的同时与 DSH 对话）：
    // wbStore 是模块级小 store，主面板按钮与 shell.overlay 悬浮窗共享。
    // v0.8.0：多文档标签（tab = {key, path, name, text, dirty, lastText}），关闭工作台后标签保留在内存，
    // 重新打开只显示空白编辑器（不自动显示上次文件）。
    const wbStore = {
      open: false,
      x: undefined, y: undefined,   // 拖动后的显式坐标；undefined = 默认右下角
      w: 660, h: 430,               // 卡片宽高（可缩放）
      fontSize: 13,                 // 编辑器字号（10-40）
      lang: 'auto',                 // 语言：auto/py/js/''（纯文本）
      tabs: [],
      active: null,                 // 当前标签 key；null = 空白编辑器
      seq: 0,
      listeners: new Set(),
    };
    function setWb(patch) {
      Object.assign(wbStore, patch);
      wbStore.listeners.forEach((fn) => { try { fn(wbStore); } catch (e) { /* ignore */ } });
    }
    function subscribeWb(fn) {
      wbStore.listeners.add(fn);
      return () => wbStore.listeners.delete(fn);
    }
    function makeTab(partial) {
      const tab = Object.assign({ key: 't' + (++wbStore.seq), path: '', name: '未命名', text: '', dirty: false, lastText: '' }, partial || {});
      tab.lastText = tab.text;
      return tab;
    }
    function focusTab(key) { setWb({ open: true, active: key }); }
    function addTab(tab) { setWb({ tabs: wbStore.tabs.concat([tab]), active: tab.key, open: true }); }
    function removeTab(key) {
      const idx = wbStore.tabs.findIndex((t) => t.key === key);
      const tabs = wbStore.tabs.filter((t) => t.key !== key);
      const active = wbStore.active === key ? (tabs.length ? tabs[Math.max(0, idx - 1)].key : null) : wbStore.active;
      setWb({ tabs: tabs, active: active });
    }
    // v0.9.0：标签拖拽排序（Word/WPS 式）。
    function reorderTab(fromKey, toIndex) {
      const tabs = wbStore.tabs.slice();
      const from = tabs.findIndex((t) => t.key === fromKey);
      if (from === -1 || toIndex < 0 || toIndex >= tabs.length || from === toIndex) return;
      const [moved] = tabs.splice(from, 1);
      tabs.splice(from < toIndex ? toIndex - 1 : toIndex, 0, moved);
      setWb({ tabs: tabs });
    }
    function updateTab(key, patch) {
      setWb({ tabs: wbStore.tabs.map((t) => (t.key === key ? Object.assign({}, t, patch) : t)) });
    }
    function openWorkbench(path) {
      // 有路径：加标签并聚焦（已存在则切换）；无路径：只打开（空白编辑器，不自动显示上次文件）。
      if (path) {
        const existing = wbStore.tabs.find((t) => t.path && t.path === path);
        if (existing) focusTab(existing.key);
        else addTab(makeTab({ path: path, name: String(path).split(/[\\/]/).pop() || String(path), text: '', dirty: false, lastText: '' }));
      } else {
        setWb({ open: true });
      }
    }
    // 全局文件拖拽监测（v0.8.0）：拖拽期间把面板/工作台/把手 zIndex 提到最上层，越过 DSH 的模糊投放遮罩。
    const dragState = { depth: 0, raise: false, listeners: new Set() };
    function notifyDrag() {
      const raise = dragState.depth > 0;
      if (raise === dragState.raise) return;
      dragState.raise = raise;
      dragState.listeners.forEach((fn) => { try { fn(raise); } catch (e) { /* ignore */ } });
    }
    function subscribeDrag(fn) {
      dragState.listeners.add(fn);
      return () => dragState.listeners.delete(fn);
    }
    function hasFiles(ev) {
      try { return !!ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') !== -1; }
      catch (e) { return false; }
    }
    let dragWired = false;
    function wireDragWatcher() {
      if (dragWired || typeof window === 'undefined') return;
      dragWired = true;
      window.addEventListener('dragenter', (ev) => { if (hasFiles(ev)) { dragState.depth++; notifyDrag(); } });
      window.addEventListener('dragleave', (ev) => { if (hasFiles(ev)) { dragState.depth = Math.max(0, dragState.depth - 1); notifyDrag(); } });
      window.addEventListener('drop', () => { if (dragState.depth > 0) { dragState.depth = 0; notifyDrag(); } });
    }
    // v0.9.1：我们的 drop 处理器都 stopPropagation，DSH 的投放遮罩（dsh-client-ui-attachment 在 document 上监听
    // drop，并在 window 上监听 dragend → reset）收不到事件，遮罩会一直残留。此函数收尾我方拖拽状态，
    // 并向 window 派发合成 dragend，让 DSH 用自己的 reset 路径撤掉模糊投放遮罩（等同把文件拖进了对话框）。
    function endDragSession() {
      try {
        dragState.depth = 0;
        notifyDrag();
      } catch (e) { /* ignore */ }
      try {
        window.dispatchEvent(new Event('dragend'));
      } catch (e) { /* ignore */ }
    }

    // 暂存区：拖到面板或「选择文件…」的文件先进入 pendingStore，由用户决定「发送给dsh」或「在工作台编辑」。
    const pendingStore = { items: [], listeners: new Set(), seq: 0 };
    function setPending(items) {
      pendingStore.items = items;
      pendingStore.listeners.forEach((fn) => { try { fn(items); } catch (e) { /* ignore */ } });
    }
    function subscribePending(fn) {
      pendingStore.listeners.add(fn);
      return () => pendingStore.listeners.delete(fn);
    }
    function readFileText(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('FileReader 读取失败'));
        r.readAsText(file);
      });
    }
    function base64ToText(data) {
      try {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) { return null; }
    }
    function textToBase64(text) {
      try {
        const bytes = new TextEncoder().encode(String(text || ''));
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      } catch (e) { return null; }
    }

    const zh = { title: 'VScode' };
    const en = { title: 'VScode' };

    // 具体色值（深色主题友好，同时不依赖应用令牌）
    const C = {
      primary: '#0066B8',
      white: '#ffffff',
      text: 'inherit',
      textDim: 'rgba(128,128,128,0.95)',
      cardBg: 'rgba(128,128,128,0.10)',
      cardBorder: 'rgba(128,128,128,0.28)',
      btnBg: 'rgba(128,128,128,0.22)',
      btnBorder: 'rgba(128,128,128,0.48)',
      dash: 'rgba(128,128,128,0.35)',
      dropBg: 'rgba(0,102,184,0.16)',
    };

    function extOf(name) {
      const idx = String(name || '').lastIndexOf('.');
      return idx >= 0 ? String(name).slice(idx + 1).toLowerCase() : '';
    }

    function getRpc(ctx) {
      try {
        const connection = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
        if (connection && connection.rpc && typeof connection.rpc.call === 'function') return connection.rpc;
      } catch (e) { /* ignore */ }
      return undefined;
    }

    async function call(endpoint, payload) {
      const rpc = getRpc(rootCtx);
      if (!rpc) return { ok: false, error: { code: 'no-rpc', message: 'RPC 通道不可用（connection 服务未就绪）' } };
      try {
        return await rpc.call(CHANNEL, endpoint, payload || {});
      } catch (e) {
        return { ok: false, error: { code: 'rpc-failed', message: String((e && e.message) || e) } };
      }
    }

    function shortId(id) {
      return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id || '');
    }

    function fmtSize(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    }

    const btn = (primary) => ({
      display: 'inline-block',
      border: '1px solid ' + (primary ? C.primary : C.btnBorder),
      borderRadius: 6,
      padding: '5px 12px',
      fontSize: 13,
      lineHeight: '18px',
      cursor: 'pointer',
      color: primary ? C.white : C.text,
      background: primary ? C.primary : C.btnBg,
    });
    const card = {
      background: C.cardBg,
      border: '1px solid ' + C.cardBorder,
      borderRadius: 8,
      padding: 10,
    };
    const secondary = { fontSize: 12, color: C.textDim, wordBreak: 'break-all', marginTop: 4 };
    const inputStyle = {
      flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, fontSize: 13,
      border: '1px solid ' + C.btnBorder,
      background: C.btnBg, color: C.text,
    };

    function SidebarIcon(props) {
      const s = (props && props.size) || 20;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', style: { display: 'block' } },
        h('rect', { x: 1, y: 4, width: 22, height: 16, rx: 3.2, fill: '#f5f5f5' }),
        h('path', { d: 'M4.2 7.4 L8.8 12 L4.2 16.6 L6.1 16.6 L10.7 12 L6.1 7.4 Z', fill: '#1e1e1e' }),
        h('path', { d: 'M12.6 8.2 L16.6 12 L12.6 15.8 L14.5 15.8 L18.5 12 L14.5 8.2 Z', fill: '#1e1e1e' })
      );
    }

    function MainPanel() {
      const [workspaces, setWorkspaces] = useState([]);
      const [selected, setSelected] = useState('');
      const [files, setFiles] = useState([]);
      const [truncated, setTruncated] = useState(false);
      const [status, setStatus] = useState('');
      const [manual, setManual] = useState('');
      const [busy, setBusy] = useState(false);
      const [sendState, setSendState] = useState({});
      const [openState, setOpenState] = useState({});
      const [drag, setDrag] = useState(false);
      const [dropBusy, setDropBusy] = useState(false);
      const [curSess, setCurSess] = useState(null);
      const [pending, setPendingItems] = useState(pendingStore.items);
      const [pendingSend, setPendingSend] = useState({});
      const [dragRaise, setDragRaise] = useState(dragState.raise);

      useEffect(() => subscribePending(setPendingItems), []);
      useEffect(() => subscribeDrag(setDragRaise), []);

      async function detect() {
        setBusy(true);
        const res = await call('detectWorkspace');
        setBusy(false);
        if (res && res.ok) {
          const ws = (res.value && res.value.workspaces) || [];
          setWorkspaces(ws);
          if (ws.length === 1) {
            setStatus('已自动选择工作区');
            selectWorkspace(ws[0].path);
          } else if (ws.length > 1) {
            setStatus('检测到 ' + ws.length + ' 个工作区，请选择');
          } else {
            setStatus('未检测到工作区：请在 VS Code 中打开过文件夹，或手动输入路径');
          }
        } else {
          setStatus('检测失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      async function selectWorkspace(p) {
        setSelected(p);
        setFiles([]);
        setTruncated(false);
        setStatus('正在列出文件…');
        const res = await call('listWorkspaceFiles', { workspace: p });
        if (res && res.ok) {
          setFiles((res.value && res.value.files) || []);
          setTruncated(!!(res.value && res.value.truncated));
          setStatus('已列出 ' + ((res.value && res.value.files && res.value.files.length) || 0) + ' 个文件' + (res.value && res.value.truncated ? '（列表已截断）' : ''));
        } else {
          setStatus('列文件失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      async function openIde() {
        setBusy(true);
        const res = await call('openVsCode', { workspace: selected || undefined });
        setBusy(false);
        if (res && res.ok) {
          const v = res.value || {};
          const via = v.kind === 'shortcut' ? '（桌面快捷方式）' : '';
          setStatus('VS Code 已启动' + via + (v.workspace ? '（工作区：' + v.workspace + '）' : ''));
        } else {
          setStatus('启动失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      async function openFile(f) {
        setOpenState((prev) => Object.assign({}, prev, { [f.path]: true }));
        const res = await call('openFileInVsCode', { path: f.path });
        setOpenState((prev) => Object.assign({}, prev, { [f.path]: false }));
        if (res && res.ok) {
          setStatus('已在 VS Code 中打开「' + f.name + '」');
        } else {
          setStatus('打开失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      async function sendFile(f) {
        const sessionId = sessionIdRef.current;
        if (!sessionId) {
          setStatus('未检测到打开的对话：请先在 DSH 中打开一个对话窗口，再发送文件');
          return;
        }
        setSendState((prev) => Object.assign({}, prev, { [f.path]: 'sending' }));
        const res = await call('sendFileAttachmentToDsh', { path: f.path, sessionId: sessionId });
        call('logClient', { msg: 'sendFile result ok=' + !!(res && res.ok) + ' err=' + ((res && res.error && res.error.message) || '') + ' viaAttachment=' + !!(res && res.ok && res.value && res.value.viaAttachment) });
        if (res && res.ok) {
          setSendState((prev) => Object.assign({}, prev, { [f.path]: 'ok' }));
          const via = res.value && res.value.viaAttachment ? '原文件' : '文件内容';
          setStatus('已发送「' + f.name + '」' + via + '到 DSH 会话 ' + shortId(res.value && res.value.sessionId));
        } else {
          setSendState((prev) => Object.assign({}, prev, { [f.path]: 'err' }));
          setStatus('发送失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      function arrayBufferToBase64(buf) {
        let binary = '';
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      }

      function readFileBase64(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(arrayBufferToBase64(reader.result));
          reader.onerror = () => reject(new Error('FileReader 读取失败'));
          reader.readAsArrayBuffer(file);
        });
      }

      async function stageFiles(fileList) {
        if (!fileList || !fileList.length) return;
        setDropBusy(true);
        const arr = Array.from(fileList);
        call('logClient', { msg: 'stageFiles count=' + arr.length + ' names=' + arr.map((f) => f && f.name).join('|').slice(0, 300) });
        const items = [];
        for (const f of arr) {
          const name = (f && f.name) || '未命名文件';
          const size = (f && typeof f.size === 'number') ? f.size : null;
          const localPath = f && f.path ? String(f.path) : '';
          const item = { key: 'stg-' + (++pendingStore.seq), name: name, size: size, path: localPath || undefined, data: undefined, text: undefined };
          if (!localPath) {
            try {
              const data = await readFileBase64(f);
              item.data = data || undefined;
              if (size != null && size <= 8 * 1024 * 1024) item.text = base64ToText(data);
              else item.text = null;
            } catch (e) {
              call('logClient', { msg: 'stage reader threw ' + String((e && e.message) || e) });
              item.text = null;
            }
          }
          items.push(item);
        }
        setPending(pendingStore.items.concat(items));
        setStatus('已暂存 ' + items.length + ' 个文件：可「发送给dsh」或「在工作台编辑」');
        setDropBusy(false);
      }

      async function sendStaged(item) {
        const sessionId = sessionIdRef.current;
        if (!sessionId) {
          setStatus('未检测到打开的对话：请先打开一个对话窗口，再发送文件');
          return;
        }
        setPendingSend((prev) => Object.assign({}, prev, { [item.key]: true }));
        const res = item.path
          ? await call('sendFileAttachmentToDsh', { path: item.path, sessionId: sessionId })
          : await call('sendFileAttachmentToDsh', { name: item.name, data: item.data, sessionId: sessionId });
        setPendingSend((prev) => Object.assign({}, prev, { [item.key]: false }));
        call('logClient', { msg: 'staged send ok=' + !!(res && res.ok) + ' err=' + ((res && res.error && res.error.message) || '') });
        if (res && res.ok) {
          setStatus('已发送「' + item.name + '」' + (res.value && res.value.viaAttachment ? '原文件' : '文件内容') + '到 DSH 会话 ' + shortId(res.value && res.value.sessionId));
        } else {
          setStatus('发送失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      function editStaged(item) {
        if (item.path) { openWorkbench(item.path); return; }
        if (item.text) {
          setWb({ open: true });
          addTab(makeTab({ path: '', name: item.name, text: item.text, dirty: false, lastText: item.text }));
          return;
        }
        setStatus('「' + item.name + '」内容未载入（过大或读取失败），无法在工作台编辑');
      }

      function removeStaged(key) {
        setPending(pendingStore.items.filter((it) => it.key !== key));
      }

      function pickFiles() {
        if (typeof document === 'undefined') return;
        let input;
        try {
          input = document.createElement('input');
        } catch (e) {
          setStatus('无法创建文件选择框：' + String((e && e.message) || e));
          return;
        }
        input.type = 'file';
        input.multiple = true;
        input.style.display = 'none';
        input.onchange = () => {
          const n = input && input.files ? input.files.length : 0;
          const names = [];
          if (input && input.files) { for (const f of input.files) names.push(f && f.name); }
          call('logClient', { msg: 'pickFiles onchange count=' + n + ' names=' + names.join('|').slice(0, 300) + ' hasPath=' + (input.files && input.files[0] && !!input.files[0].path) });
          if (input && input.files) stageFiles(input.files);
        };
        document.body.appendChild(input);
        setStatus('正在打开文件选择对话框…');
        try {
          input.click();
        } catch (e) {
          setStatus('打开文件选择对话框失败：' + String((e && e.message) || e));
        }
        setTimeout(() => { try { document.body.removeChild(input); } catch (e) { /* ignore */ } }, 5 * 60 * 1000);
      }

      async function pickFolder() {
        setBusy(true);
        let p;
        try {
          const uiWorkspace = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('uiWorkspace') : undefined;
          if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
            setBusy(false);
            setStatus('当前版本不支持文件夹选择器，请用下方输入框手动输入路径');
            return;
          }
          p = await uiWorkspace.pickDirectory();
        } catch (e) { p = undefined; }
        setBusy(false);
        if (p) {
          await selectWorkspace(p);
        } else {
          setStatus('未选择文件夹');
        }
      }

      useEffect(() => { detect(); }, []);

      useEffect(() => {
        const refresh = () => setCurSess(sessionIdRef.current || null);
        refresh();
        let adapter;
        try {
          const uiSession = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('uiSession') : undefined;
          adapter = uiSession && uiSession.adapter && uiSession.adapter.current;
        } catch (e) { adapter = undefined; }
        if (adapter && typeof adapter.subscribe === 'function') return adapter.subscribe(refresh);
      }, []);

      function renderFileRow(f) {
        const st = sendState[f.path];
        const ot = openState[f.path];
        return h('div', {
          key: f.path,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px dashed ' + C.dash },
        },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
              h('span', { style: { wordBreak: 'break-all' } }, f.name),
              f.size != null ? h('span', { style: Object.assign({}, secondary, { marginTop: 0, flexShrink: 0 }) }, fmtSize(f.size)) : null
            ),
            h('div', { style: secondary }, f.rel)
          ),
          h('button', {
            onClick: () => openFile(f),
            disabled: !!ot || busy,
            style: Object.assign({}, btn(false), { flexShrink: 0, fontSize: 12, padding: '4px 8px' }),
          }, '在 VS Code 中打开'),
          h('button', {
            onClick: () => openWorkbench(f.path),
            disabled: busy,
            style: Object.assign({}, btn(false), { flexShrink: 0, fontSize: 12, padding: '4px 8px' }),
          }, '编辑'),
          h('button', {
            onClick: () => sendFile(f),
            disabled: st === 'sending' || st === 'ok',
            style: Object.assign({}, btn(true), { flexShrink: 0, fontSize: 12, padding: '4px 8px', opacity: st === 'sending' || st === 'ok' ? 0.6 : 1 }),
          }, st === 'sending' ? '发送中…' : st === 'ok' ? '已发送' : st === 'err' ? '重试' : '发送给 DSH')
        );
      }

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 10, padding: 14,
          height: '100%', overflowY: 'auto', boxSizing: 'border-box', fontSize: 13,
          color: C.text, background: 'transparent', position: 'relative',
          zIndex: dragRaise ? 2147483000 : undefined,
        },
        onDragOver: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!drag) setDrag(true);
        },
        onDragLeave: (ev) => {
          ev.preventDefault();
          if (ev.target === ev.currentTarget) setDrag(false);
        },
        onDrop: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setDrag(false);
          endDragSession();
          stageFiles(ev.dataTransfer && ev.dataTransfer.files);
        },
      },
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, 'VScode'),
        h('div', { style: secondary }, busy ? '处理中…' : (status || '就绪')),
        h('div', { style: secondary }, '当前对话：' + (curSess ? shortId(curSess) : '未检测到（请先打开一个对话窗口）')),
        h('div', {
          style: {
            border: '1px dashed ' + C.btnBorder, borderRadius: 8, padding: '10px 12px',
            fontSize: 12, color: C.textDim, textAlign: 'center',
          },
        }, '📄 拖拽文件到此处（或本面板任意位置），先暂存到「暂存区」，再选择「发送给dsh」或「在工作台编辑」；拖到工作台卡片则直接编辑'),
        h('button', {
          onClick: openIde, disabled: busy,
          style: Object.assign({}, btn(true), { alignSelf: 'flex-start', opacity: busy ? 0.6 : 1 }),
        }, '打开 VS Code'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', {
            onClick: pickFiles, disabled: busy,
            style: Object.assign({}, btn(false), { opacity: busy ? 0.6 : 1 }),
          }, '选择文件…'),
          h('button', {
            onClick: pickFolder, disabled: busy,
            style: Object.assign({}, btn(false), { opacity: busy ? 0.6 : 1 }),
          }, '浏览文件夹…'),
          h('button', {
            onClick: () => openWorkbench(''), disabled: busy,
            style: Object.assign({}, btn(false), { opacity: busy ? 0.6 : 1 }),
          }, '工作台')
        ),
        pending.length > 0
          ? h('div', { style: card },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                h('div', { style: { fontWeight: 600, flex: 1 } }, '暂存区（' + pending.length + '）'),
                h('button', {
                  onClick: () => setPending([]), disabled: busy,
                  style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 10px' }),
                }, '清空')
              ),
              pending.map((item) => h('div', {
                key: item.key,
                style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px dashed ' + C.dash },
              },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { wordBreak: 'break-all' } }, item.name),
                  h('div', { style: secondary }, (item.size != null ? fmtSize(item.size) + ' · ' : '') + (item.path ? '磁盘文件' : (item.text ? '内容已载入内存' : '内容未载入')))
                ),
                h('button', {
                  onClick: () => editStaged(item),
                  disabled: busy || pendingSend[item.key] || (!item.path && !item.text),
                  style: Object.assign({}, btn(false), { flexShrink: 0, fontSize: 12, padding: '4px 8px' }),
                }, '在工作台编辑'),
                h('button', {
                  onClick: () => sendStaged(item),
                  disabled: busy || pendingSend[item.key] || (!item.path && !item.data),
                  style: Object.assign({}, btn(true), { flexShrink: 0, fontSize: 12, padding: '4px 8px', opacity: pendingSend[item.key] ? 0.6 : 1 }),
                }, pendingSend[item.key] ? '发送中…' : '发送给dsh'),
                h('button', {
                  onClick: () => removeStaged(item.key),
                  disabled: busy || pendingSend[item.key],
                  style: Object.assign({}, btn(false), { flexShrink: 0, fontSize: 12, padding: '4px 8px' }),
                }, '移除')
              ))
            )
          : null,
        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '工作区'),
          workspaces.length > 0
            ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
                workspaces.map((w) => h('button', {
                  key: w.path,
                  onClick: () => selectWorkspace(w.path),
                  style: Object.assign({}, btn(false), w.path === selected ? { outline: '2px solid ' + C.primary } : {}),
                }, w.label))
              )
            : null,
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { onClick: detect, disabled: busy, style: btn(false) }, '重新检测'),
            h('input', {
              value: manual,
              onChange: (ev) => setManual(ev.target.value),
              placeholder: '或手动输入文件夹路径',
              style: inputStyle,
            }),
            h('button', {
              onClick: () => { const p = manual.trim(); if (p) selectWorkspace(p); },
              disabled: busy || !manual.trim(),
              style: btn(false),
            }, '使用')
          ),
          selected ? h('div', { style: secondary }, '当前：' + selected) : null
        ),
        h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('div', { style: { fontWeight: 600, flex: 1 } },
              '文件（' + files.length + (truncated ? '，列表已截断' : '）')),
            selected ? h('button', {
              onClick: () => selectWorkspace(selected), disabled: busy,
              style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 10px' }),
            }, '刷新列表') : null
          ),
          files.length === 0
            ? h('div', { style: secondary }, '请先选择工作区')
            : files.map(renderFileRow)
        ),
        drag
          ? h('div', {
              style: {
                position: 'absolute', top: 8, left: 8, right: 8, bottom: 8,
                border: '2px dashed ' + C.primary, borderRadius: 12,
                background: C.dropBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, color: C.primary, zIndex: 10, pointerEvents: 'none',
              },
            }, dropBusy ? '正在暂存…' : '松开鼠标，把文件暂存到面板')
          : null
      );
    }

    // ---- 语法着色（VS Code Dark+ 配色；逐行轻量分词；>120KB 关闭以保流畅）----
    const HL_COLORS = {
      kw: '#569CD6', str: '#CE9178', num: '#B5CEA8', com: '#6A9955',
      fn: '#DCDCAA', builtin: '#4EC9B0', plain: '#D4D4D4',
    };
    const HL_LANG = {
      py: {
        comment: '#', block: null, kwSet: new Set(['and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield','True','False','None']),
        biSet: new Set(['self','print','range','len','int','float','str','list','dict','set','tuple','open','type','isinstance','enumerate','zip','map','filter','super','input','min','max','sum','abs','round']),
      },
      js: {
        comment: '//', block: ['/*', '*/'], kwSet: new Set(['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','typeof','instanceof','in','of','class','extends','super','this','null','undefined','true','false','try','catch','finally','throw','async','await','import','export','from','default','yield','delete','void','static','get','set']),
        biSet: new Set(['console','document','window','Math','JSON','Object','Array','String','Number','Boolean','Promise','Set','Map','Date','RegExp','parseInt','parseFloat']),
      },
      c: {
        comment: '//', block: ['/*', '*/'],
        kwSet: new Set(['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','inline','int','long','register','restrict','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while','bool','true','false']),
        biSet: new Set(['printf','scanf','fprintf','sprintf','fopen','fclose','fread','fwrite','fgets','fputs','malloc','calloc','realloc','free','NULL','FILE','stdin','stdout','stderr','size_t','ssize_t','EOF','main','memcpy','memmove','memset','strlen','strcpy','strcmp','strcat','atoi','atof','atol','abs','cout','cin','endl','std','string','vector','using','namespace']),
      },
    };
    function detectLang(name, text) {
      const e = extOf(name);
      if (e === 'py' || e === 'pyw') return 'py';
      if (e === 'js' || e === 'mjs' || e === 'cjs' || e === 'ts' || e === 'jsx' || e === 'tsx' || e === 'json') return 'js';
      if (e === 'c' || e === 'h' || e === 'cpp' || e === 'cc' || e === 'cxx' || e === 'hpp' || e === 'hh' || e === 'hxx') return 'c';
      // 无扩展名/内存文本：内容启发式
      const head = String(text || '').slice(0, 2000);
      if (/^\s*(#![^\n]*python[^\n]*|from\s+[A-Za-z_][\w.]*\s+import\s|import\s+[A-Za-z_][\w.]*)/m.test(head) || /\bdef\s+\w+\s*\(/.test(head)) return 'py';
      if (/\b(const|let|var)\s+\w+\s*=|function\s*\w*\s*\(|\bawait\s/.test(head)) return 'js';
      if (/^\s*#\s*include\s*[<"]/m.test(head) || /\bint\s+main\s*\(/.test(head) || /\b(size_t|uint\d+_t|printf|scanf|malloc|free|cout|cin)\b/.test(head)) return 'c';
      return '';
    }
    function hlScanLine(line, spec, state) {
      const out = [];
      let i = 0;
      const n = line.length;
      const push = (t, s) => { if (s) out.push({ t, s }); };
      while (i < n) {
        if (state.block) {
          const end = line.indexOf(spec.block[1], i);
          if (end === -1) { push('com', line.slice(i)); i = n; }
          else { push('com', line.slice(i, end + 2)); i = end + 2; state.block = false; }
          continue;
        }
        const ch = line[i];
        if (spec.block && ch === spec.block[0][0] && line.slice(i, i + 2) === spec.block[0]) {
          const end = line.indexOf(spec.block[1], i + 2);
          if (end === -1) { push('com', line.slice(i)); i = n; state.block = true; }
          else { push('com', line.slice(i, end + 2)); i = end + 2; }
          continue;
        }
        if (spec.comment && ch === spec.comment[0] && line.slice(i, i + spec.comment.length) === spec.comment) {
          push('com', line.slice(i)); i = n;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          let j = i + 1;
          while (j < n && line[j] !== ch) { if (line[j] === '\\') j++; j++; }
          j = Math.min(j + 1, n);
          push('str', line.slice(i, j)); i = j;
          continue;
        }
        if (ch >= '0' && ch <= '9') {
          let j = i + 1;
          while (j < n && /[0-9A-Za-z_.]/.test(line[j])) j++;
          push('num', line.slice(i, j)); i = j;
          continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
          let j = i + 1;
          while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
          const word = line.slice(i, j);
          let k = j;
          while (k < n && line[k] === ' ') k++;
          if (spec.kwSet.has(word)) push('kw', word);
          else if (spec.biSet.has(word)) push('builtin', word);
          else if (k < n && line[k] === '(') push('fn', word);
          else push('plain', word);
          i = j;
          continue;
        }
        push('plain', ch); i++;
      }
      return out;
    }
    function highlightTokens(text, langKey) {
      const spec = HL_LANG[langKey];
      if (!spec) return [{ t: 'plain', s: String(text || '') }];
      const state = { block: false };
      const out = [];
      const lines = String(text || '').split('\n');
      for (let li = 0; li < lines.length; li++) {
        if (li > 0) out.push({ t: 'plain', s: '\n' });
        const part = hlScanLine(lines[li], spec, state);
        for (const tk of part) out.push(tk);
      }
      return out;
    }

    // 括号/引号自动配对（v0.7.0）
    const PAIR_OPEN = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    const PAIR_CLOSE = { ')': '(', ']': '[', '}': '{', '"': '"', "'": "'", '`': '`' };
    // 任意边界/角缩放热区（v0.7.0）：四边 6px、四角 12×12。
    const EDGES = [
      { e: 'n', style: { top: 0, left: 12, right: 12, height: 6, cursor: 'ns-resize' } },
      { e: 's', style: { bottom: 0, left: 12, right: 12, height: 6, cursor: 'ns-resize' } },
      { e: 'w', style: { left: 0, top: 12, bottom: 12, width: 6, cursor: 'ew-resize' } },
      { e: 'e', style: { right: 0, top: 12, bottom: 12, width: 6, cursor: 'ew-resize' } },
      { e: 'nw', style: { top: 0, left: 0, width: 12, height: 12, cursor: 'nwse-resize' } },
      { e: 'ne', style: { top: 0, right: 0, width: 12, height: 12, cursor: 'nesw-resize' } },
      { e: 'sw', style: { bottom: 0, left: 0, width: 12, height: 12, cursor: 'nesw-resize' } },
      { e: 'se', style: { bottom: 0, right: 0, width: 12, height: 12, cursor: 'nwse-resize' } },
    ];

    function WorkbenchOverlay() {
      const [, force] = useState(0);
      const [wbText, setWbText] = useState('');
      const [wbPath, setWbPath] = useState('');
      const [wbName, setWbName] = useState('');
      const [wbStatus, setWbStatus] = useState('');
      const [wbSyncing, setWbSyncing] = useState(false);
      const [wbBusy, setWbBusy] = useState(false);
      const [closeModal, setCloseModal] = useState(null); // {key, name, path}
      const [dragRaise, setDragRaise] = useState(dragState.raise);
      const [fsText, setFsText] = useState(null); // null=镜像 wbStore.fontSize；编辑中=本地文本（v0.9.0 字号输入修复）
      const [dragKey, setDragKey] = useState(null); // 正在拖拽的标签 key（标签排序）
      const [dropIdx, setDropIdx] = useState(-1); // 拖拽悬停的标签下标
      const preRef = useRef(null);
      const taRef = useRef(null);

      useEffect(() => {
        const off = subscribeWb(() => force((n) => n + 1));
        const offDrag = subscribeDrag(setDragRaise);
        return () => { off(); offDrag(); };
      }, []);

      // 当前标签镜像：active 标签变化时把其内容载入编辑器。
      useEffect(() => {
        const tab = wbStore.tabs.find((t) => t.key === wbStore.active) || null;
        setWbText(tab ? tab.text : '');
        setWbPath(tab && tab.path ? tab.path : '');
        setWbName(tab ? tab.name : '');
      }, [wbStore.active, wbStore.tabs]);

      function activeTab() {
        return wbStore.tabs.find((t) => t.key === wbStore.active) || null;
      }
      function onTextChange(v) {
        setWbText(v);
        const tab = activeTab();
        if (tab) updateTab(tab.key, { text: v, dirty: v !== tab.lastText });
      }
      async function saveTab(tab) {
        if (!tab) return false;
        if (tab.path) {
          setWbBusy(true);
          const res = await call('writeFileFromPanel', { path: tab.path, content: tab.text });
          setWbBusy(false);
          if (res && res.ok) {
            updateTab(tab.key, { lastText: tab.text, dirty: false });
            setWbStatus('已保存到盘：' + tab.path);
            return true;
          }
          setWbStatus('保存失败：' + ((res && res.error && res.error.message) || '未知错误'));
          return false;
        }
        // 无路径：浏览器下载保存
        try {
          const blob = new Blob([tab.text], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = tab.name || '未命名.txt';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { try { URL.revokeObjectURL(a.href); document.body.removeChild(a); } catch (e) { /* ignore */ } }, 1000);
          updateTab(tab.key, { lastText: tab.text, dirty: false });
          setWbStatus('已下载保存：' + (tab.name || '未命名.txt'));
          return true;
        } catch (e) {
          setWbStatus('保存失败：' + String((e && e.message) || e));
          return false;
        }
      }
      function closeTabAsk(key) {
        const tab = wbStore.tabs.find((t) => t.key === key);
        if (!tab) return;
        if (tab.dirty) { setCloseModal({ key: key, name: tab.name, path: tab.path }); return; }
        removeTab(key);
        setWbStatus('已关闭「' + tab.name + '」');
      }
      function confirmClose(save) {
        const m = closeModal;
        setCloseModal(null);
        if (!m) return;
        const tab = wbStore.tabs.find((t) => t.key === m.key);
        if (!tab) return;
        if (save) {
          saveTab(tab).then((ok) => { if (ok) { removeTab(tab.key); setWbStatus('已保存并关闭「' + tab.name + '」'); } });
        } else {
          removeTab(tab.key);
          setWbStatus('已关闭「' + tab.name + '」（未保存）');
        }
      }

      // 文件拖进工作台：逐文件加标签并聚焦（不再替换旧文件）。
      async function wbAddFile(f) {
        const name = (f && f.name) || '未命名文件';
        const localPath = f && f.path ? String(f.path) : '';
        call('logClient', { msg: 'wbAddFile name=' + name + ' hasPath=' + !!localPath });
        if (localPath) {
          const existing = wbStore.tabs.find((t) => t.path && t.path === localPath);
          if (existing) { focusTab(existing.key); setWbStatus('已切换到「' + existing.name + '」'); return; }
          setWbBusy(true);
          const res = await call('readFileForEdit', { path: localPath });
          setWbBusy(false);
          if (res && res.ok) {
            addTab(makeTab({ path: localPath, name: name, text: res.value.text, dirty: false, lastText: res.value.text }));
            setWbStatus('已打开「' + name + '」（' + (res.value.size || 0) + ' 字节）');
          } else {
            setWbStatus('读取失败：' + ((res && res.error && res.error.message) || '未知错误'));
          }
        } else {
          try {
            const text = await readFileText(f);
            addTab(makeTab({ path: '', name: name, text: text, dirty: false, lastText: text }));
            setWbStatus('已打开「' + name + '」（内存内容，未关联磁盘文件）');
          } catch (e) {
            setWbStatus('读取失败：' + String((e && e.message) || e));
          }
        }
      }
      async function wbDropFiles(fileList) {
        if (!fileList || !fileList.length) return;
        const arr = Array.from(fileList);
        call('logClient', { msg: 'wbDrop count=' + arr.length + ' names=' + arr.map((f) => f && f.name).join('|').slice(0, 300) });
        for (const f of arr) await wbAddFile(f);
      }

      function wbRead(p) {
        if (!p) return;
        setWbBusy(true);
        setWbStatus('正在读取…');
        call('readFileForEdit', { path: p }).then((res) => {
          setWbBusy(false);
          if (res && res.ok) {
            addTab(makeTab({ path: p, name: String(p).split(/[\\/]/).pop() || String(p), text: res.value.text, dirty: false, lastText: res.value.text }));
            setWbStatus('已打开「' + p + '」（' + (res.value.size || 0) + ' 字节）');
          } else {
            setWbStatus('读取失败：' + ((res && res.error && res.error.message) || '未知错误'));
          }
        });
      }

      async function wbSave() {
        const tab = activeTab();
        if (!tab) { setWbStatus('没有打开的文档：先把文件拖到工作台，或在面板点文件行的「编辑」'); return; }
        await saveTab(tab);
      }

      async function wbSyncNow() {
        if (!wbText) { setWbStatus('编辑器为空，没有可发送的内容'); return; }
        const tab = activeTab();
        const name = (tab && tab.name) || wbName || '工作台.txt';
        const data = textToBase64(wbText);
        if (data === null) { setWbStatus('发送失败：内容编码失败'); return; }
        setWbBusy(true);
        const res = await call('sendFileAttachmentToDsh', { name: name, data: data, sessionId: sessionIdRef.current || undefined });
        setWbBusy(false);
        if (res && res.ok) {
          const v = res.value || {};
          if (v.viaAttachment === false) {
            setWbStatus('当前对话由子代理路由持有，已改以文本内容发送（' + name + '）');
          } else {
            setWbStatus('已发送原文件（' + name + (typeof v.bytes === 'number' ? '，' + fmtSize(v.bytes) : '') + '）');
          }
        } else {
          setWbStatus('发送失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      async function wbSyncToggle() {
        if (wbSyncing) {
          await call('syncStop', { path: wbPath });
          setWbSyncing(false);
          setWbStatus('已停止自动同步');
          return;
        }
        if (!wbPath) { setWbStatus('当前文档未关联磁盘文件（无路径），无法自动同步'); return; }
        if (!sessionIdRef.current) { setWbStatus('未检测到打开的对话，无法自动同步'); return; }
        const res = await call('syncStart', { path: wbPath, sessionId: sessionIdRef.current });
        if (res && res.ok) {
          setWbSyncing(true);
          setWbStatus('自动同步已开启：文件保存后约 1.5 秒自动发给 DSH 解析');
        } else {
          setWbStatus('开启自动同步失败：' + ((res && res.error && res.error.message) || '未知错误'));
        }
      }

      // v0.7.0：VS Code 风格符号自动配对 + Enter 自动缩进。
      function wbKeyDown(e) {
        const ta = taRef.current;
        if (!ta) return;
        const val = wbText;
        const s = ta.selectionStart, en = ta.selectionEnd;
        const restoreCaret = (pos) => {
          requestAnimationFrame(() => {
            try { ta.focus(); ta.setSelectionRange(pos, pos); } catch (err) { /* ignore */ }
          });
        };
        if (e.key === 'Enter') {
          e.preventDefault();
          const lineStart = val.lastIndexOf('\n', s - 1) + 1;
          const indent = (/^[ \t]*/.exec(val.slice(lineStart, s)) || [''])[0];
          const insert = '\n' + indent;
          onTextChange(val.slice(0, s) + insert + val.slice(en));
          restoreCaret(s + insert.length);
          return;
        }
        if (PAIR_OPEN[e.key] !== undefined) {
          e.preventDefault();
          const close = PAIR_OPEN[e.key];
          if (s !== en) {
            const sel = val.slice(s, en);
            onTextChange(val.slice(0, s) + e.key + sel + close + val.slice(en));
            requestAnimationFrame(() => {
              try { ta.focus(); ta.setSelectionRange(s + 1, en + 1); } catch (err) { /* ignore */ }
            });
          } else {
            onTextChange(val.slice(0, s) + e.key + close + val.slice(s));
            restoreCaret(s + 1);
          }
          return;
        }
        if (PAIR_CLOSE[e.key] !== undefined && s === en && val[s] === e.key) {
          // 输入闭符恰好落在已自动补全的闭符上 → 跳过而非重复输入。
          e.preventDefault();
          restoreCaret(s + 1);
          return;
        }
        if (e.key === 'Backspace' && s === en && s > 0) {
          const prev = val[s - 1], next = val[s];
          if (PAIR_OPEN[prev] !== undefined && PAIR_OPEN[prev] === next) {
            e.preventDefault();
            onTextChange(val.slice(0, s - 1) + val.slice(s + 1));
            restoreCaret(s - 1);
          }
        }
      }

      function beginDrag(ev, mode, edge) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const startX = ev.clientX, startY = ev.clientY;
        const vw = window.innerWidth, vh = window.innerHeight;
        const baseX = wbStore.x !== undefined ? wbStore.x : Math.max(0, vw - wbStore.w - 24);
        const baseY = wbStore.y !== undefined ? wbStore.y : Math.max(0, vh - wbStore.h - 24);
        const baseW = wbStore.w, baseH = wbStore.h;
        const MINW = 360, MINH = 220;
        const move = (e) => {
          const dx = e.clientX - startX, dy = e.clientY - startY;
          if (mode === 'move') {
            setWb({ x: Math.max(0, Math.min(vw - 48, baseX + dx)), y: Math.max(0, Math.min(vh - 40, baseY + dy)) });
            return;
          }
          // 任意边界/角缩放：e/s 拉边、w/n 拉边同时移动左/上边，保证对边不动。
          const hasE = edge.indexOf('e') !== -1, hasS = edge.indexOf('s') !== -1;
          const hasW = edge.indexOf('w') !== -1, hasN = edge.indexOf('n') !== -1;
          let x = baseX, y = baseY, w = baseW, h = baseH;
          if (hasE) w = Math.max(MINW, baseW + dx);
          if (hasS) h = Math.max(MINH, baseH + dy);
          if (hasW) { w = Math.max(MINW, baseW - dx); x = baseX + baseW - w; }
          if (hasN) { h = Math.max(MINH, baseH - dy); y = baseY + baseH - h; }
          x = Math.max(0, Math.min(x, vw - MINW));
          y = Math.max(0, Math.min(y, vh - MINH));
          w = Math.min(w, vw - 8 - x);
          h = Math.min(h, vh - 8 - y);
          setWb({ x: x, y: y, w: w, h: h });
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      }

      const fontSize = wbStore.fontSize;
      const codeStyle = {
        fontFamily: 'Consolas, Menlo, "Courier New", monospace',
        fontSize: fontSize + 'px', lineHeight: 1.5, padding: 10,
        whiteSpace: 'pre', boxSizing: 'border-box', width: '100%', height: '100%',
        tabSize: 4,
      };
      // 注意：useMemo 必须在条件 return 之前调用，否则 hooks 数量在不同渲染间变化会崩组件。
      // v0.8.0：语言 = 手动选择（非 auto）优先；auto 时按文件名（wbName/wbPath）再按内容启发式检测。
      const tabLang = wbStore.lang === 'auto'
        ? detectLang(wbName || wbPath, wbText)
        : (wbStore.lang === 'py' ? 'py' : wbStore.lang === 'js' ? 'js' : wbStore.lang === 'c' ? 'c' : '');
      const highlight = useMemo(() => {
        const tokens = wbText && wbText.length <= 120000
          ? highlightTokens(wbText, tabLang)
          : [{ t: 'plain', s: wbText || '' }];
        return tokens.map((tk, idx) => (tk.t === 'plain' ? tk.s : h('span', { key: idx, style: { color: HL_COLORS[tk.t] } }, tk.s)));
      }, [wbText, wbName, wbPath, wbStore.lang]);

      // ---- 右侧边栏入口：关闭时在右边缘显示「工作台」把手 ----
      if (!wbStore.open) {
        return wrapOverlay(h('div', {
          style: { position: 'fixed', right: 0, top: '42%', zIndex: dragRaise ? 2147483000 : 1000, pointerEvents: 'auto' },
          onDragOver: (ev) => { ev.preventDefault(); ev.stopPropagation(); },
          onDrop: (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            endDragSession();
            setWb({ open: true });
            wbDropFiles(ev.dataTransfer && ev.dataTransfer.files);
          },
        },
          h('button', {
            onClick: () => setWb({ open: true }),
            title: '打开工作台（也可把文件直接拖到此按钮上）',
            style: {
              writingMode: 'vertical-rl', cursor: 'pointer', padding: '10px 6px',
              background: C.primary, color: C.white, border: '1px solid ' + C.primary,
              borderRight: 'none', borderRadius: '8px 0 0 8px', fontSize: 12, fontWeight: 600,
              boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
            },
          }, '工作台')
        ));
      }

      const cardPos = {};
      if (wbStore.x !== undefined) { cardPos.left = wbStore.x; cardPos.top = wbStore.y; }
      else { cardPos.right = 16; cardPos.bottom = 16; }

      return wrapOverlay(h('div', {
        style: Object.assign({
          position: 'fixed', zIndex: dragRaise ? 2147483000 : 1000, pointerEvents: 'auto', display: 'flex', flexDirection: 'column',
          width: wbStore.w, height: wbStore.h, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)',
          background: 'rgba(28,28,32,0.97)', border: '1px solid ' + C.btnBorder,
          borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
          fontSize: 13, color: C.text,
        }, cardPos),
        onDragOver: (ev) => { ev.preventDefault(); ev.stopPropagation(); },
        onDrop: (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          endDragSession();
          wbDropFiles(ev.dataTransfer && ev.dataTransfer.files);
        },
      },
        h('div', { style: { flexShrink: 0 } },
          // 文档标签条（Word/WPS 式，v0.8.0）：可切换/关闭；● 表示有未保存修改。
          wbStore.tabs.length
            ? h('div', { style: { display: 'flex', alignItems: 'stretch', borderBottom: '1px solid ' + C.btnBorder, overflowX: 'auto' } },
                wbStore.tabs.map((tb, ti) => h('div', {
                  key: tb.key,
                  onClick: () => { if (wbStore.active !== tb.key) focusTab(tb.key); },
                  title: tb.path || tb.name,
                  draggable: true,
                  onDragStart: (ev) => {
                    setDragKey(tb.key);
                    try { ev.dataTransfer.setData('text/plain', String(tb.key)); ev.dataTransfer.effectAllowed = 'move'; } catch (e2) { /* ignore */ }
                  },
                  onDragEnd: () => { setDragKey(null); setDropIdx(-1); },
                  onDragOver: (ev) => {
                    if (dragKey && dragKey !== tb.key) { ev.preventDefault(); ev.stopPropagation(); setDropIdx(ti); }
                  },
                  onDrop: (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    endDragSession();
                    if (dragKey && dragKey !== tb.key) reorderTab(dragKey, ti);
                    setDragKey(null); setDropIdx(-1);
                  },
                  style: {
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer',
                    fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0, userSelect: 'none',
                    background: wbStore.active === tb.key ? 'rgba(0,102,184,0.35)' : 'transparent',
                    color: wbStore.active === tb.key ? C.white : C.textDim,
                    borderRight: '1px solid ' + C.btnBorder,
                    borderLeft: (dragKey && dragKey !== tb.key && dropIdx === ti) ? '2px solid ' + C.primary : '2px solid transparent',
                    opacity: dragKey === tb.key ? 0.55 : 1,
                  },
                },
                  h('span', {}, tb.dirty ? tb.name + ' ●' : tb.name),
                  h('span', {
                    onClick: (ev) => { ev.stopPropagation(); closeTabAsk(tb.key); },
                    title: '关闭标签',
                    style: { padding: '0 3px', borderRadius: 3 },
                  }, '×')
                )))
              : null,
          h('div', {
            onPointerDown: (ev) => beginDrag(ev, 'move'),
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
              borderBottom: '1px solid ' + C.btnBorder, cursor: 'move', userSelect: 'none', touchAction: 'none',
            },
          },
            h('div', { style: { fontWeight: 600, flexShrink: 0 } }, '工作台'),
            h('div', { style: Object.assign({}, secondary, { flexShrink: 0, marginTop: 0 }) }, '（拖动标题栏移动）'),
            h('input', {
              value: wbPath,
              onChange: (ev) => setWbPath(ev.target.value),
              onPointerDown: (ev) => ev.stopPropagation(),
              placeholder: '文件完整路径',
              style: Object.assign({}, inputStyle, { fontSize: 12 }),
            }),
            h('button', { onClick: () => wbRead(wbPath), disabled: wbBusy || !wbPath, style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 10px', flexShrink: 0 }) }, '读取'),
            h('select', {
              value: wbStore.lang,
              onPointerDown: (ev) => ev.stopPropagation(),
              onChange: (ev) => setWb({ lang: ev.target.value }),
              title: '编辑器语言',
              style: Object.assign({}, inputStyle, { fontSize: 12, width: 92, padding: '3px 6px', flexShrink: 0, background: '#23232b', color: '#e8e8e8', borderColor: C.btnBorder }),
            },
              h('option', { value: 'auto', style: { background: '#23232b', color: '#e8e8e8' } }, '自动'),
              h('option', { value: 'py', style: { background: '#23232b', color: '#e8e8e8' } }, 'Python'),
              h('option', { value: 'js', style: { background: '#23232b', color: '#e8e8e8' } }, 'JavaScript'),
              h('option', { value: 'c', style: { background: '#23232b', color: '#e8e8e8' } }, 'C/C++'),
              h('option', { value: '', style: { background: '#23232b', color: '#e8e8e8' } }, '纯文本')
            ),
            h('button', { onClick: () => setWb({ open: false }), style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 10px', flexShrink: 0 }) }, '关闭')
          )
        ),
        h('div', { style: { position: 'relative', flex: 1, minHeight: 60, overflow: 'hidden' } },
          wbStore.active === null
            ? h('div', {
                style: {
                  position: 'absolute', inset: 0, zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: C.textDim, fontSize: 13, textAlign: 'center', padding: 20, background: 'transparent',
                },
              }, '没有打开的文档：把文件拖到工作台，或在 VScode 面板点文件行的「编辑」；支持多标签页')
            : null,
          h('pre', {
            ref: preRef,
            'aria-hidden': 'true',
            style: Object.assign({}, codeStyle, {
              position: 'absolute', inset: 0, margin: 0, zIndex: 1,
              pointerEvents: 'none', overflow: 'hidden', color: HL_COLORS.plain,
            }),
          }, highlight),
          h('textarea', {
            ref: taRef,
            value: wbText,
            onChange: (ev) => onTextChange(ev.target.value),
            onKeyDown: wbKeyDown,
            onScroll: (ev) => {
              if (preRef.current) {
                preRef.current.scrollTop = ev.target.scrollTop;
                preRef.current.scrollLeft = ev.target.scrollLeft;
              }
            },
            spellCheck: false,
            wrap: 'off',
            style: Object.assign({}, codeStyle, {
              position: 'absolute', inset: 0, margin: 0, zIndex: 2,
              background: 'transparent', color: 'transparent', caretColor: '#e0e0e0',
              border: 'none', outline: 'none', resize: 'none', overflow: 'auto',
            }),
          })
        ),
        EDGES.map((ed) => h('div', {
          key: 'edge-' + ed.e,
          onPointerDown: (ev) => beginDrag(ev, 'resize', ed.e),
          title: '拖动调整大小',
          style: Object.assign({ position: 'absolute', zIndex: 6, touchAction: 'none' }, ed.style),
        })),
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            borderTop: '1px solid ' + C.btnBorder, flexWrap: 'wrap', flexShrink: 0,
          },
        },
          h('button', { onClick: wbSave, disabled: wbBusy, style: Object.assign({}, btn(true), { fontSize: 12, padding: '3px 10px' }) }, '保存到盘'),
          h('button', { onClick: wbSyncNow, disabled: wbBusy, style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 10px' }) }, '发送给 DSH'),
          h('button', {
            onClick: wbSyncToggle, disabled: wbBusy,
            style: Object.assign({}, wbSyncing ? btn(true) : btn(false), { fontSize: 12, padding: '3px 10px' }),
          }, wbSyncing ? '自动同步：开' : '自动同步：关'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 } },
            h('button', { onClick: () => setWb({ fontSize: Math.max(10, Math.min(40, fontSize - 1)) }), style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 8px' }) }, '字号-'),
            h('input', {
              type: 'text', inputMode: 'numeric',
              value: fsText !== null ? fsText : String(fontSize),
              onFocus: (ev) => { setFsText(String(fontSize)); },
              onChange: (ev) => {
                // 编辑期只保存本地文本（不钳制），避免逐键 Math.max(10,…) 把中间输入改坏（v0.9.0 修复）。
                const raw = String(ev.target.value || '').replace(/[^0-9]/g, '');
                setFsText(raw);
                const n = parseInt(raw, 10);
                if (Number.isFinite(n) && n >= 10 && n <= 40) setWb({ fontSize: n });
              },
              onBlur: () => {
                const n = parseInt(fsText, 10);
                setWb({ fontSize: Number.isFinite(n) ? Math.max(10, Math.min(40, n)) : 13 });
                setFsText(null);
              },
              onKeyDown: (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') ev.target.blur(); },
              title: '字号（10-40，可手动输入，回车或失焦生效）',
              style: Object.assign({}, inputStyle, { width: 52, fontSize: 12, padding: '3px 6px', textAlign: 'center' }),
            }),
            h('div', { style: Object.assign({}, secondary, { marginTop: 0 }) }, 'px'),
            h('button', { onClick: () => setWb({ fontSize: Math.max(10, Math.min(40, fontSize + 1)) }), style: Object.assign({}, btn(false), { fontSize: 12, padding: '3px 8px' }) }, '字号+')
          ),
          h('div', { style: Object.assign({}, secondary, { flex: 1, minWidth: 120, marginTop: 0 }) }, wbBusy ? '处理中…' : (wbStatus || '就绪')),
          // 关闭标签的保存询问（v0.8.0）
          closeModal
            ? h('div', {
                style: {
                  position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.6)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                },
              },
                h('div', { style: { background: 'rgba(28,28,32,0.98)', border: '1px solid ' + C.btnBorder, borderRadius: 10, padding: 16, maxWidth: 420 } },
                  h('div', { style: { marginBottom: 12 } }, '是否保存对「' + closeModal.name + '」的更改？'),
                  h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                    h('button', { onClick: () => confirmClose(true), style: Object.assign({}, btn(true), { fontSize: 12, padding: '4px 12px' }) }, '保存'),
                    h('button', { onClick: () => confirmClose(false), style: Object.assign({}, btn(false), { fontSize: 12, padding: '4px 12px' }) }, '不保存'),
                    h('button', { onClick: () => setCloseModal(null), style: Object.assign({}, btn(false), { fontSize: 12, padding: '4px 12px' }) }, '取消')
                  )
                )
              )
            : null
        )
      ));
    }

    return {
      inject: ['slots', 'connection', 'locale', 'uiSession', 'uiWorkspace'],
      apply(ctx) {
        rootCtx = ctx;
        watchCurrentSession(ctx);
        wireDragWatcher();
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vscode-sidebar: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'vscode-sidebar',
          order: 30,
          label: () => t('title'),
          locale: NS,
        }, SidebarIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'vscode-sidebar',
          locale: NS,
        }, MainPanel));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'vscode-workbench',
          order: 25,
        }, WorkbenchOverlay));
        // 诊断探针：客户端半体加载成功即写宿主侧标记文件（供排查「刷新后无图标」）。
        call('clientLoaded', { href: String((typeof location !== 'undefined' && location.href) || ''), now: Date.now(), version: '1.1.1', portal: canPortal });
      },
    };
  },
});
