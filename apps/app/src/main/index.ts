import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { createAppLogger, redactLogText } from "@main/logger";
import { YukinoBridge } from "@main/yukino-bridge";
import { app, dialog, shell, BrowserWindow } from "electron";

import icon from "../../resources/icon.png?asset";

const logDirectory = join(app.getPath("userData"), "logs");
const logging = createAppLogger({
  directory: logDirectory,
  version: app.getVersion(),
  level: process.env.YUKINO_LOG_LEVEL,
  console: is.dev,
});
if (logging.filePath) {
  app.setAppLogsPath(logDirectory);
}
const log = logging.logger.child({ component: "main" });
const bridge = new YukinoBridge(logging.logger);

log.info(
  { logFile: logging.filePath, electron: process.versions.electron },
  "Application starting",
);
process.on("uncaughtExceptionMonitor", (err, origin) => {
  log.fatal({ err, origin }, "Uncaught main process exception");
  logging.flush();
});
process.on("unhandledRejection", (err: unknown) => {
  log.fatal({ err }, "Unhandled main process rejection");
  logging.flush();
  app.exit(1);
});
process.on("exit", () => {
  logging.flush();
});
app.on("child-process-gone", (_event, details) => {
  if (details.reason !== "clean-exit") {
    log.error(
      {
        processType: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
      },
      "Child process exited unexpectedly",
    );
  }
});

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
    log.info({ windowId: mainWindow.id }, "Window ready");
    mainWindow.show();
  });
  const rendererLog = logging.logger.child({
    component: "renderer",
    windowId: mainWindow.id,
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") {
      rendererLog[details.level === "error" ? "error" : "warn"](
        {
          err: new Error(details.message),
          source: redactLogText(details.sourceId),
          line: details.lineNumber,
        },
        "Renderer console message",
      );
    }
  });
  mainWindow.webContents.on("preload-error", (_event, path, err) => {
    rendererLog.error({ err, path }, "Preload failed");
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      rendererLog.error(
        { reason: details.reason, exitCode: details.exitCode },
        "Renderer exited unexpectedly",
      );
    }
  });
  mainWindow.webContents.on("unresponsive", () => {
    rendererLog.warn("Renderer is unresponsive");
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        rendererLog.error({ code, description }, "Renderer failed to load");
      }
    },
  );

  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Return to Save", "Discard and Close"],
      defaultId: 0,
      cancelId: 0,
      message: "Unsaved files",
      detail: "Closing the window will discard drafts in the editor.",
    });
    if (choice === 1) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//u.test(details.url)) {
      void shell.openExternal(details.url).catch((err: unknown) => {
        log.warn({ err }, "Could not open an external link");
      });
    }
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow
      .loadURL(process.env.ELECTRON_RENDERER_URL)
      .catch((err: unknown) => {
        rendererLog.error({ err }, "Could not load the development renderer");
      });
  } else {
    void mainWindow
      .loadFile(join(__dirname, "../renderer/index.html"))
      .catch((err: unknown) => {
        rendererLog.error({ err }, "Could not load the renderer");
      });
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app
  .whenReady()
  .then(() => {
    log.info("Application ready");
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
  })
  .catch((err: unknown) => {
    log.fatal({ err }, "Application startup failed");
    logging.flush();
    app.exit(1);
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
  log.info("Application stopping");
  void bridge
    .dispose()
    .catch((err: unknown) => {
      log.error({ err }, "Agent cleanup failed");
    })
    .then(async () => {
      log.info("Application stopped");
      await logging.close();
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `Could not close application logs: ${redactLogText(String(err))}\n`,
      );
    })
    .finally(() => {
      setImmediate(() => {
        shuttingDown = true;
        app.quit();
      });
    });
});
