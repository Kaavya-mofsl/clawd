const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawd', {
  onState: (cb) => ipcRenderer.on('clawd:state', (_event, payload) => cb(payload)),
  onCheer: (cb) => ipcRenderer.on('clawd:cheer', () => cb()),

  // The window is click-through, so the renderer has to ask for the mouse back
  // whenever the cursor is actually over the crab — see `hover` in pet.js.
  setInteractive: (on) => ipcRenderer.send('clawd:interactive', Boolean(on)),

  // No coordinates: main tracks the real cursor for the length of the drag. A mouse
  // event's screenX is relative to a window that is itself being dragged, which feeds
  // back into itself and sends the crab bolting sideways.
  dragStart: () => ipcRenderer.send('clawd:drag-start'),
  dragEnd: () => ipcRenderer.send('clawd:drag-end'),
});
