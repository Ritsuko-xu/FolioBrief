/** Sandboxed Electron preload bridge exposing read-only desktop runtime metadata to the React renderer. */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('foliobriefDesktop', {
  isDesktop: true,
  platform: process.platform,
});
