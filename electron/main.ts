/** Native macOS Electron shell: hosts the local Express/SQLite backend and renders FolioBrief cleanly. */
import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startFolioBriefServer, type RunningFolioServer } from '../server/bootstrap.ts';

let mainWindow: BrowserWindow | null = null;
let runningServer: RunningFolioServer | null = null;

function resolvePaths() {
  const appRoot = app.getAppPath();
  const userDataDir = app.getPath('userData');
  const distDir = path.join(appRoot, 'dist');
  const dataDir = path.join(userDataDir, 'data');
  const userEnvPath = path.join(userDataDir, '.env');
  const projectEnvPath = path.resolve(process.cwd(), '.env');

  return {
    appRoot,
    userDataDir,
    distDir,
    dataDir,
    userEnvPath,
    envPaths: [userEnvPath, path.join(appRoot, '.env'), projectEnvPath],
  };
}

function openOrCreateEnvFile(userEnvPath: string): void {
  if (!fs.existsSync(userEnvPath)) {
    fs.mkdirSync(path.dirname(userEnvPath), { recursive: true });
    fs.writeFileSync(
      userEnvPath,
      '# Add your Gemini API key below and restart FolioBrief\nGEMINI_API_KEY="MY_GEMINI_API_KEY"\n',
      'utf8'
    );
  }
  void shell.openPath(userEnvPath);
}

function buildMacMenu(dataDir: string, userEnvPath: string): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Configure API Key (.env)...',
                click: () => openOrCreateEnvFile(userEnvPath),
              },
              {
                label: 'Open Library Data Folder',
                click: () => void shell.openPath(dataDir),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Configure API Key (.env)...',
          click: () => openOrCreateEnvFile(userEnvPath),
        },
        {
          label: 'Open Library Data Folder',
          click: () => void shell.openPath(dataDir),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

async function createMainWindow(serverUrl: string) {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: 'FolioBrief',
    backgroundColor: '#FBF9F5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external article links in the user's default macOS browser rather than inside the app shell
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(serverUrl);
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.setName('FolioBrief');
  app.setAboutPanelOptions({
    applicationName: 'FolioBrief',
    applicationVersion: app.getVersion(),
    credits: 'Local-first AI reading and synthesis studio for PDFs and web articles.',
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const paths = resolvePaths();
    try {
      runningServer = await startFolioBriefServer({
        port: 0,
        host: '127.0.0.1',
        dataDir: paths.dataDir,
        distDir: paths.distDir,
        envPaths: paths.envPaths,
        useViteDevMiddleware: false,
      });

      Menu.setApplicationMenu(buildMacMenu(paths.dataDir, paths.userEnvPath));
      await createMainWindow(runningServer.url);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && runningServer) {
          void createMainWindow(runningServer.url);
        }
      });
    } catch (err) {
      dialog.showErrorBox(
        'FolioBrief Startup Error',
        `Failed to start the local backend:\n\n${(err as Error).message}`
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async () => {
    if (runningServer) {
      await runningServer.close();
      runningServer = null;
    }
  });
}
