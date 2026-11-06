import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { YukinoBridge } from "@main/yukino-bridge";
import { app, dialog, shell, BrowserWindow } from "electron";

import icon from "../../resources/icon.png?asset";

// The yukino library bridge owns the agent runtime and IPC registration.
const bridge = new YukinoBridge();

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 880,
    minHeight: 540,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#f8faf7",
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["返回保存", "放弃并关闭"],
      defaultId: 0,
      cancelId: 0,
      message: "有尚未保存的文件",
      detail: "关闭窗口将丢失编辑器中的草稿。",
    });
    if (choice === 1) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//u.test(details.url)) {
      void shell.openExternal(details.url);
    }
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("com.yukino.app");

  // Follow the OS dark/light preference unless the user picked one.
  bridge.applyTheme();
  bridge.registerIpc();

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let shuttingDown = false;
app.on("will-quit", (event) => {
  if (shuttingDown) {
    return;
  }
  event.preventDefault();
  void bridge.dispose().finally(() => {
    setImmediate(() => {
      shuttingDown = true;
      app.quit();
    });
  });
});
