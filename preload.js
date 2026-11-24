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

  // Second phone config (UDP/eyeBeam trunk; null if Phone 2 is off for this user).
  phone2Config: () => { try { return ipcRenderer.sendSync('phone2:get'); } catch (_) { return null; } },
  onPhone2Config: (cb) => ipcRenderer.on('phone2:config', (_e, cfg) => cb(cfg)),

  // Third phone — inbound ACD queue. Config + presence/queue polling API.
  inboundConfig: () => { try { return ipcRenderer.sendSync('inbound:get'); } catch (_) { return null; } },
  onInboundConfig: (cb) => ipcRenderer.on('inbound:config', (_e, cfg) => cb(cfg)),
  acdView: () => ipcRenderer.invoke('acd:view'),
  acdSet: (action, reason) => ipcRenderer.invoke('acd:set', action, reason),
  acdLog: (msg, level) => ipcRenderer.invoke('acd:log', msg, level),

  // Inbound phone native leg (registers to the queue service, handles the call).
  inboundStart: (cfg) => ipcRenderer.invoke('inbound:start', cfg),
  inboundAnswer: () => ipcRenderer.invoke('inbound:answer'),
  inboundReject: () => ipcRenderer.invoke('inbound:reject'),
  inboundHangup: () => ipcRenderer.invoke('inbound:hangup'),
  inboundHold: (on) => ipcRenderer.invoke('inbound:hold', on),
  inboundMute: (on) => ipcRenderer.invoke('inbound:mute', on),
  inboundTransfer: (uid) => ipcRenderer.invoke('inbound:transfer', uid),
  inboundStop: () => ipcRenderer.invoke('inbound:stop'),
  onInboundEvent: (cb) => ipcRenderer.on('inbound:event', (_e, ev) => cb(ev)),
  copyText: (text) => ipcRenderer.invoke('ui:copy', text),
  onInboundAudio: (cb) => ipcRenderer.on('inbound:audio', (_e, buf) => cb(buf)),
  inboundMic: (u8) => ipcRenderer.send('inbound:mic', u8),

  // Live supervision: fires true/false as an admin starts/stops watching this screen.
  onSuperviseState: (cb) => ipcRenderer.on('supervise:state', (_e, on) => cb(!!on)),
  // Report viewport size + active browser-tab geometry so injected clicks land right.
  superviseGeom: (g) => ipcRenderer.send('supervise:geom', g),

  // Admin supervision VIEWER (inside this portal): list online agents, open a
  // live screen, pull frames, and push click/type input to assist/train.
  svList: () => ipcRenderer.invoke('sv:list'),
  svStart: (uid) => ipcRenderer.invoke('sv:start', uid),
  svStop: (uid) => ipcRenderer.invoke('sv:stop', uid),
  svHeartbeat: (uid) => ipcRenderer.invoke('sv:heartbeat', uid),
  svFrame: (uid) => ipcRenderer.invoke('sv:frame', uid),
  svInput: (uid, events) => ipcRenderer.invoke('sv:input', uid, events),

  // Training: admin shares own window with selected agents + two-way audio.
  trainStart: (targets) => ipcRenderer.invoke('train:start', targets),
  trainSetTargets: (targets) => ipcRenderer.invoke('train:settargets', targets),
  trainStop: () => ipcRenderer.invoke('train:stop'),
  trainPoll: () => ipcRenderer.invoke('train:poll'),
  trainFrame: (adminId) => ipcRenderer.invoke('train:frameGet', adminId),
  trainAudioPost: (adminId, b64) => ipcRenderer.invoke('train:audioPost', adminId, b64),
  trainAudioGet: (adminId, since) => ipcRenderer.invoke('train:audioGet', adminId, since),

  // Google Sheets assigned to this user (names + ids only; the URL stays in the
  // main process and is resolved just-in-time via sheetUrl()).
  sheetsList: () => { try { return ipcRenderer.sendSync('sheets:get') || []; } catch (_) { return []; } },
  onSheetsList: (cb) => ipcRenderer.on('sheets:list', (_e, list) => cb(list || [])),
  sheetUrl: (id) => ipcRenderer.invoke('sheet:url', id),

  // Per-user password vault (encrypted server-side).
  onVaultOffer: (cb) => ipcRenderer.on('vault:offer', (_e, d) => cb(d)),
  vaultSave: () => ipcRenderer.invoke('vault:save'),
  vaultDismiss: () => ipcRenderer.invoke('vault:dismiss'),
  vaultList: () => ipcRenderer.invoke('vault:list'),
  vaultDelete: (id) => ipcRenderer.invoke('vault:delete', id),

  // Native (UDP) softphone — direct-to-trunk, no WSS. Audio bridged over IPC.
  nativeStart: (cfg) => ipcRenderer.invoke('native:start', cfg),
  nativeCall: (num, callerId) => ipcRenderer.invoke('native:call', num, callerId),
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
