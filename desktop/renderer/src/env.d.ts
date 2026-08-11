/// <reference types="vite/client" />

import type { AllyCodeDesktopApi } from "../../shared.js";

declare global {
  interface Window {
    allycode: AllyCodeDesktopApi;
  }
}

export {};
