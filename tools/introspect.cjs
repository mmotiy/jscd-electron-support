// 通用 Electron bytenode harness:用应用自带 electron.exe(ELECTRON_RUN_AS_NODE=1)
// 加载 out/main/index.jsc,mock electron 模块,枚举并驱动全部 IPC。
//
// 用法:
//   APP_DIR=/path/to/app ELECTRON_RUN_AS_NODE=1 ./App.exe introspect.cjs
//   ELECTRON 主程序路径也可以用 env ELECTRON_EXE 指定(默认参数下的相对路径见下)
// driver 步骤:同目录 driver.json:[{"ch":"pk:start","args":[],"wait":500}, ...]
// 事件落盘:同目录 events.jsonl(每次运行先清空)
//
// 设计要点(为什么这样写)见本技能 references/harness.md。

const Module = require('module');
const path = require('path');
const fs = require('fs');
const events = require('events');

const APP_DIR = process.env.APP_DIR
  ? path.resolve(process.env.APP_DIR)
  : path.resolve(__dirname, '..', 'app');   // 默认:技能用法是 harness/ 放在 app 旁

if (!fs.existsSync(path.join(APP_DIR, 'out', 'main'))) {
  console.error('[harness] APP_DIR 不对(找不到 ' + path.join(APP_DIR, 'out', 'main') + ')。用 APP_DIR=/path/to/app 指定解包出的 asar 目录。');
  process.exit(2);
}

const noop = () => {};
const OUT = p => console.log(p);

function selfHeal(name, obj) {
  return new Proxy(obj, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && !/^[0-9]+$/.test(prop)) {
        console.log(`[${name} MISS .${prop}] -> noop`);   // 迭代信号:缺什么补什么
        t[prop] = noop;
      }
      return noop;
    },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}
const mkEmitter = () => new events.EventEmitter();

const windows = new Map();
function makeWinMock() {
  const win = mkEmitter();
  win.id = 100 + windows.size;
  const wc = mkEmitter();
  wc.send = (ch, ...a) => {
    const line = JSON.stringify({ t: Date.now(), ch, a }, (k, v) => typeof v === 'bigint' ? String(v) : v);
    try { fs.appendFileSync(path.join(__dirname, 'events.jsonl'), line + '\n'); } catch {}
    console.log(`[WC-> ${ch}]`, JSON.stringify(a, (k, v) => typeof v === 'bigint' ? String(v) : v)?.slice(0, 300));
  };
  wc.loadURL = async () => {};
  wc.loadFile = async () => {};
  wc.executeJavaScript = async (code) => { console.log('[execJS len=' + code.length + ']', code.slice(0, 120).replace(/\s+/g, ' ')); return null; };
  wc.getURL = () => 'about:blank';
  win.webContents = selfHeal('webContents', wc);
  Object.assign(win, {
    loadURL: async () => {}, loadFile: async () => {},
    setFullScreen: v => { win.__fs = v; }, isFullScreen: () => !!win.__fs,
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    isDestroyed: () => false, close: noop, destroy: noop,
  });
  const wrapped = selfHeal('win', win);
  windows.set(wrapped.id, wrapped);
  return wrapped;
}

const ipcMain = mkEmitter();
const handlers = {};
ipcMain.handle = (ch, fn) => { handlers[ch] = fn; };
ipcMain.on = (ch, fn) => { handlers['EV:' + ch] = fn; };
ipcMain.removeListener = noop; ipcMain.removeHandler = noop;

const app = selfHeal('app', Object.assign(mkEmitter(), {
  isPackaged: true,
  getPath: p => path.join(__dirname, 'mockdata', p),
  getAppPath: () => APP_DIR,
  getName: () => 'harness-app',
  getVersion: () => '0.0.0',
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: noop },
}));

const electronMock = {
  app, ipcMain,
  BrowserWindow: Object.assign(function (opts) { return makeWinMock(); }, {
    getAllWindows: () => [...windows.values()],
    fromWebContents: () => null, fromId: id => windows.get(id) || null,
  }),
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), getAllDisplays: () => [{ id: 1 }] },
  dialog: { showErrorBox: noop, showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop },
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
  Tray: function () { const t = mkEmitter(); Object.assign(t, { setContextMenu: noop, setToolTip: noop, setImage: noop }); return t; },
  nativeImage: { createFromPath: () => ({ toDataURL: () => '', getSize: () => ({ width: 1, height: 1 }) }), createEmpty: () => ({}) },
  globalShortcut: { register: noop, unregisterAll: noop },
  clipboard: { writeText: noop, readText: () => '' },
  session: { defaultSession: selfHeal('session', { protocol: selfHeal('proto', {}) }) },
  protocol: selfHeal('protocol-top', { registerFileProtocol: noop, registerStreamProtocol: noop, registerBufferProtocol: noop, handle: async () => {}, registerSchemesAsPrivileged: noop }),
  net: selfHeal('net', {}),
  powerMonitor: mkEmitter(),
  systemPreferences: selfHeal('syspref', {}),
  contextBridge: { exposeInMainWorld: noop },
  ipcRenderer: mkEmitter(),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return origLoad.apply(this, arguments);
};

process.chdir(APP_DIR);
try { fs.rmSync(path.join(__dirname, 'events.jsonl'), { force: true }); } catch {}
require(path.join(APP_DIR, 'node_modules', 'bytenode'));

let mod;
try {
  mod = require(path.join(APP_DIR, 'out', 'main', 'index.jsc'));
  OUT('[harness] MAIN LOADED OK, exports: ' + JSON.stringify(Object.keys(mod)));
} catch (e) {
  OUT('[harness] MAIN LOAD FAIL:\n' + (e && e.stack ? e.stack.split('\n').slice(0, 10).join('\n') : e));
  process.exit(1);
}

// 触发 ready(app.whenReady 已 resolve;再广播 ready 兼容 app.on('ready') 写法)
setTimeout(async () => {
  try { app.emit('ready'); } catch {}
  console.log('\n=== windows:', [...windows.values()].length);
  console.log('=== IPC handlers (' + Object.keys(handlers).length + '):');
  console.log(Object.keys(handlers).join(', '));

  const driverPath = path.join(__dirname, 'driver.json');
  try {
    const steps = JSON.parse(fs.readFileSync(driverPath, 'utf8'));
    console.log('\n=== driver: ' + steps.length + ' steps');
    for (const st of steps) {
      console.log('\n>>> CALL ' + st.ch + ' ' + JSON.stringify(st.args));
      try {
        const r = await handlers[st.ch]({ sender: makeWinMock().webContents }, ...(st.args || []));
        try { fs.writeFileSync(path.join(__dirname, 'last_' + st.ch.replace(/[^a-z0-9-]/gi, '_') + '.json'), JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v, 2)); } catch {}
        console.log('<<< ' + JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v)?.slice(0, 300));
      } catch (e) { console.log('<<< ERR ' + e.message); }
      await new Promise(r => setTimeout(r, st.wait || 300));
    }
  } catch (e) { console.log('(no driver steps: ' + e.message + ')'); }

  setTimeout(() => { console.log('\n=== handlers AFTER driver ===\n' + Object.keys(handlers).join(', ')); process.exit(0); }, 2000);
}, 2500);
