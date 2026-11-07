const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portal', {
  // Auth & session
  login: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  acceptConsent: () => ipcRenderer.invoke('auth:consent'),

  // Monitoring
  heartbeat: () => ipcRenderer.invoke('monitor:heartbeat'),
  reportEvent: (type, meta) => ipcRenderer.invoke('monitor:event', { type, meta }),
  reportViolation: (url, shot) => ipcRenderer.invoke('monitor:violation', { url, shot }),
  cameraEvent: (reason, shot) => ipcRenderer.invoke('camera:event', { reason, shot }),

  // Exit (close / minimize) password gate
  onExitRequest: (cb) => ipcRenderer.on('exit:request', (_e, mode) => cb(mode)),
  verifyExit: (password) => ipcRenderer.invoke('exit:verify', { password }),
  doExit: (mode) => ipcRenderer.invoke('exit:do', { mode }),
  setShiftEnd: (ms) => ipcRenderer.send('shift:end', ms),
  appVersion: () => { try { return ipcRenderer.sendSync('app:version'); } catch (_) { return ''; } },

  // Website hard-block notification (from the network filter)
  onNavBlocked: (cb) => ipcRenderer.on('nav:blocked', (_e, url) => cb(url)),

  // A popup/new-window was intercepted; load it inside the locked webview.
  onNavExternal: (cb) => ipcRenderer.on('nav:external', (_e, url) => cb(url)),
  onHttpAuth: (cb) => ipcRenderer.on('httpauth:prompt', (_e, info) => cb(info)),
  httpAuthSubmit: (c) => ipcRenderer.send('httpauth:submit', c),
  httpAuthCancel: () => ipcRenderer.send('httpauth:cancel'),
  onFindOpen: (cb) => ipcRenderer.on('find:open', () => cb()),
  onFindClose: (cb) => ipcRenderer.on('find:close', () => cb()),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, info) => cb(info)),

  // Live policy/flags pushed from the main process after a server poll.
  onPolicyUpdate: (cb) => ipcRenderer.on('policy:update', (_e, data) => cb(data)),

  // Pre-login update status: 'checking' | 'downloading' | 'installing' | 'ready'.
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, pct) => cb(pct)),

  // SIP softphone config (null if calling is off for this user).
  phoneConfig: () => { try { return ipcRenderer.sendSync('phone:get'); } catch (_) { return null; } },
  onPhoneConfig: (cb) => ipcRenderer.on('phone:config', (_e, cfg) => cb(cfg)),

  // Google Sheets assigned to this user (names + ids only; the URL stays in the
  // main process and is resolved just-in-time via sheetUrl()).
  sheetsList: () => { try { return ipcRenderer.sendSync('sheets:get') || []; } catch (_) { return []; } },
  onSheetsList: (cb) => ipcRenderer.on('sheets:list', (_e, list) => cb(list || [])),
  sheetUrl: (id) => ipcRenderer.invoke('sheet:url', id),

  // Native (UDP) softphone — direct-to-trunk, no WSS. Audio bridged over IPC.
  nativeStart: (cfg) => ipcRenderer.invoke('native:start', cfg),
  nativeCall: (num) => ipcRenderer.invoke('native:call', num),
  nativeHangup: () => ipcRenderer.invoke('native:hangup'),
  nativeDtmf: (d) => ipcRenderer.invoke('native:dtmf', d),
  nativeMute: (on) => ipcRenderer.invoke('native:mute', on),
  nativeStop: () => ipcRenderer.invoke('native:stop'),
  nativeMic: (int16) => ipcRenderer.send('native:mic', int16), // Int16Array @8k

  // Deepgram live captions for the in-app browser (returns a short-lived token).
  dgToken: () => ipcRenderer.invoke('dg:token'),
  onNativeEvent: (cb) => ipcRenderer.on('native:event', (_e, m) => cb(m)),
  onNativeAudio: (cb) => ipcRenderer.on('native:audio', (_e, buf) => cb(buf)),

  // Internal clipboard (copy/paste works inside the portal, isolated from the OS).
  clipLock: () => { try { return ipcRenderer.sendSync('clip:lock'); } catch (_) { return true; } },
  clipSet: (t) => ipcRenderer.send('clip:set', t),
  clipGet: () => { try { return ipcRenderer.sendSync('clip:get'); } catch (_) { return ''; } },
  clipPaste: () => { try { return ipcRenderer.sendSync('clip:paste'); } catch (_) { return ''; } },
  clipHistory: () => { try { return ipcRenderer.sendSync('clip:history') || []; } catch (_) { return []; } },
  clipPick: (t) => ipcRenderer.send('clip:pick', t),
  clipClearHistory: () => { try { return ipcRenderer.sendSync('clip:clearhistory'); } catch (_) { return false; } },

  // Chat (direct). #sale dispatch is detected server-side from the message body.
  chatContacts: () => ipcRenderer.invoke('chat:contacts'),
  chatMessages: (withId, afterId) => ipcRenderer.invoke('chat:messages', { withId, afterId }),
  chatSend: (to, body) => ipcRenderer.invoke('chat:send', { to, body }),

  // Sale actions (wait / processing / processed / assign) + availability + activity.
  saleAction: (saleId, action, secs, processorId) =>
    ipcRenderer.invoke('sale:action', { saleId, action, secs, processorId }),
  setWorkStatus: (status) => ipcRenderer.invoke('work:status', { status }),
  activity: () => ipcRenderer.invoke('group:activity'),
  groupActivity: () => ipcRenderer.invoke('group:activity'), // kept for compatibility
});
