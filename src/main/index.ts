import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { registerAuthHandlers } from "./auth.js";
import { registerApiHandlers } from "./api.js";
import { registerUploadHandlers } from "./ipcUpload.js";
import { registerFileHandlers } from "./files.js";

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  if (process.env.OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  registerAuthHandlers(ipcMain);
  registerApiHandlers(ipcMain);
  registerUploadHandlers(ipcMain);
  registerFileHandlers(ipcMain);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
