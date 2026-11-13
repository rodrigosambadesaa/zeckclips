// App de escritorio de ZeckClips (Electron): arranca el servidor local y abre la ventana.
const { app, BrowserWindow, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { createServer, listen, platformDir } = require('./server');

// los binarios (ffmpeg, yt-dlp) van en resources/bin al instalar; en desarrollo, en bin/<so>-<arquitectura>
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin', platformDir());

if (!app.requestSingleInstanceLock()) app.quit();

let win;
async function start() {
  const server = createServer({ root: path.join(__dirname, 'app'), binDir, nodeRuntime: process.execPath });
  const port = await listen(server, 41780);

  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 420, minHeight: 600,
    backgroundColor: '#0d0f14', title: 'ZeckClips', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  // los enlaces externos se abren en el navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        shell.openExternal(target.href).catch(() => {});
      }
    } catch {} // Do not pass arbitrary URI schemes to the OS.
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault();
  });

  // los MP4 y .srt exportados se guardan directamente en Descargas/ZeckClips
  win.webContents.session.on('will-download', (_e, item) => {
    const dir = path.join(app.getPath('downloads'), 'ZeckClips');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(item.getFilename()), base = path.basename(item.getFilename(), ext);
    let file = path.join(dir, base + ext);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i})${ext}`);
    item.setSavePath(file);
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      const n = new Notification({ title: 'ZeckClips', body: `Guardado en Descargas/ZeckClips: ${path.basename(file)}` });
      n.on('click', () => shell.showItemInFolder(file));
      n.show();
    });
  });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
