import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL } from './channels.js';

contextBridge.exposeInMainWorld('hostileBridgeHost', {
  report: (status: { room: string; guests: number }) =>
    ipcRenderer.send(CHANNEL.bridgeReport, status),
});
