import type { ElectronAPI } from "@electron-toolkit/preload";
import type { YukinoApi } from "@shared/ipc-types";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: YukinoApi;
  }
}
