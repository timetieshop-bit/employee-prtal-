// Native inbound SIP leg for the third phone. Unlike sip-core.js (which dials a
// carrier), this REGISTERs to our own queue service and RECEIVES calls from it:
// it answers/rejects, carries G.711 audio over RTP, and sends hold/transfer as
// in-dialog SIP INFO. Because the queue service is the media anchor and latches
// onto wherever our RTP arrives (symmetric RTP), this leg needs no STUN/NAT
// tricks — it just advertises its local port and talks to the service's address.
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const g711 = require('./g711.js');

const rnd = (n) => crypto.randomBytes(n).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function primaryIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const a of ifs[name]) {
    if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) return a.address;
  }
  return '127.0.0.1';
}
function parseMsg(str) {
  const idx = str.indexOf('\r\n\r\n');
  const head = idx >= 0 ? str.slice(0, idx) : str;
  const body = idx >= 0 ? str.slice(idx + 4) : '';
  const lines = head.split('\r\n'); const first = lines.shift() || '';
  const headers = {};
  for (const line of lines) { const c = line.indexOf(':'); if (c < 0) continue; const k = line.slice(0, c).trim().toLowerCase(); const v = line.slice(c + 1).trim(); headers[k] = headers[k] === undefined ? v : headers[k] + ',' + v; }
  const m = /^SIP\/2\.0\s+(\d+)\s+(.*)$/.exec(first);
  const rq = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(first);
  return { first, status: m ? parseInt(m[1], 10) : null, reason: m ? m[2] : '', method: rq ? rq[1] : null, uri: rq ? rq[2] : null, headers, body };
}
function parseAuth(h) { const o = { scheme: 'Digest' }; const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g; let m; while ((m = re.exec(h))) o[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3]; return o; }
function parseSdp(body) {
  if (!body) return null; let ip = null, port = null, payload = 0;
  const ml = /m=audio\s+(\d+)\s+RTP\/AVP\s+([\d\s]+)/.exec(body);
  if (ml) { port = parseInt(ml[1], 10); const pts = ml[2].trim().split(/\s+/).map(Number); payload = pts.includes(0) ? 0 : (pts.includes(8) ? 8 : pts[0]); }
  const cl = /c=IN IP4\s+([\d.]+)/.exec(body); if (cl) ip = cl[1];
  return (port && ip) ? { ip, port, payload } : null;
}

class Rtp {
  constructor(localIp) { this.localIp = localIp; this.sock = null; this.localPort = 0; this.remoteIp = null; this.remotePort = 0; this.payload = 0; this.seq = Math.floor(Math.random() * 65535); this.ts = Math.floor(Math.random() * 2 ** 31); this.ssrc = Math.floor(Math.random() * 2 ** 31); this.txQueue = []; this.txTimer = null; this.muted = false; this.onPcm = null;
    // Receive-side RTP resequencing. Incoming packets are keyed by their 16-bit
    // sequence number and released to the decoder strictly IN ORDER — home Wi-Fi /
    // consumer routers reorder and duplicate UDP constantly, and playing packets in
    // arrival order (as we used to) scrambles the audio into distortion even when
    // nothing is actually lost. Duplicates are dropped; a truly missing packet is
    // concealed with one 20 ms silence frame once RX_WIN packets have piled up
    // behind the gap, so a single loss can't stall the stream.
    this.rxMap = new Map();   // seq -> payload Buffer (copied out of the socket buffer)
    this.rxNext = -1;         // next seq to release; -1 until the first packet seen
    this.RX_WIN = 4;          // reorder depth (~80 ms) before a gap is treated as lost
  }
  open(cb) {
    this.sock = dgram.createSocket('udp4'); this.sock.on('error', () => {});
    this.sock.on('message', (b, r) => this._recv(b, r));
    const p = 12000 + (Math.floor(Math.random() * 8000) * 2 % 16000);
    this.sock.once('error', () => { try { this.sock.close(); } catch (_) {} this.sock = dgram.createSocket('udp4'); this.sock.on('message', (b, r) => this._recv(b, r)); this.sock.bind(() => { this.localPort = this.sock.address().port; cb && cb(); }); });
    this.sock.bind(p, () => { this.localPort = this.sock.address().port; cb && cb(); });
  }
  setRemote(ip, port, payload) { this.remoteIp = ip; this.remotePort = port; this.payload = payload === 8 ? 8 : 0; }
  writePcm(pcm) {
    if (!this.remoteIp) return;
    // Send the mic frame immediately, paced by the mic's own audio clock. This is
    // the key to clean agent→customer audio: a JS 20ms timer drifts against the
    // audio clock and the resulting queue over/underrun was the distortion. One
    // worklet frame = 160 samples = one 20ms packet.
    this.lastTx = Date.now();
    this._send(this.muted ? new Int16Array(pcm.length || 160) : pcm);
  }
  startSending() {
    if (this.txTimer) return;
    // Audio is now sent directly from writePcm (mic-clock paced). This timer is
    // only a keepalive: if the mic stalls for a moment, emit a silence frame so
    // the RTP stream and the NAT pinhole stay alive.
    this.txTimer = setInterval(() => {
      if (!this.remoteIp) return;
      if (Date.now() - (this.lastTx || 0) >= 40) { this.lastTx = Date.now(); this._send(new Int16Array(160)); }
    }, 20);
  }
  _send(pcm) {
    if (!this.remoteIp) return;
    const enc = this.payload === 8 ? g711.encodeAlaw(pcm) : g711.encodeUlaw(pcm);
    const pkt = Buffer.allocUnsafe(12 + enc.length);
    pkt[0] = 0x80; pkt[1] = this.payload & 0x7f;
    pkt.writeUInt16BE(this.seq & 0xffff, 2); this.seq = (this.seq + 1) & 0xffff;
    pkt.writeUInt32BE(this.ts >>> 0, 4); this.ts = (this.ts + 160) >>> 0;
    pkt.writeUInt32BE(this.ssrc >>> 0, 8); enc.copy(pkt, 12);
    try { this.sock.send(pkt, this.remotePort, this.remoteIp); } catch (_) {}
  }
  _recv(buf, rinfo) {
    if (buf.length < 12) return;
    if (rinfo && rinfo.address && (this.remoteIp !== rinfo.address || this.remotePort !== rinfo.port)) { this.remoteIp = rinfo.address; this.remotePort = rinfo.port; }
    const pt = buf[1] & 0x7f;
    if (pt !== 0 && pt !== 8) return;                 // only G.711 media (skip DTMF/telephone-event etc.)
    const seq = buf.readUInt16BE(2);
    const pl = Buffer.from(buf.subarray(12));         // copy: Node reuses the socket buffer after this returns
    if (this.rxNext < 0) this.rxNext = seq;           // first packet seen → start playout here
    const ahead = (seq - this.rxNext) & 0xffff;
    if (ahead >= 0x8000) return;                      // seq is behind the playout point → late or duplicate, drop
    if (ahead > 1000) { this.rxMap.clear(); this.rxNext = seq; } // huge forward jump (SSRC reset / long gap) → resync
    if (this.rxMap.has(seq)) return;                  // duplicate
    this.rxMap.set(seq, { pt, pl });
    this._drainRx();
  }
  _drainRx() {
    for (;;) {
      const cur = this.rxMap.get(this.rxNext);
      if (cur) {
        this.rxMap.delete(this.rxNext);
        this._emitPcm(cur.pt === 8 ? g711.decodeAlaw(cur.pl) : g711.decodeUlaw(cur.pl));
        this.rxNext = (this.rxNext + 1) & 0xffff;
        continue;
      }
      // The next expected packet isn't here yet. If enough packets have queued up
      // behind the gap, it's genuinely lost (or too late to use) — conceal it with
      // one silence frame and move on so a single loss can't stall the stream.
      if (this.rxMap.size > this.RX_WIN) {
        this._emitPcm(new Int16Array(160));           // 20 ms @ 8k silence (loss concealment)
        this.rxNext = (this.rxNext + 1) & 0xffff;
        continue;
      }
      break; // wait a moment for the out-of-order packet to arrive
    }
  }
  _emitPcm(pcm) { if (this.onPcm && pcm) this.onPcm(pcm); }
  close() { if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; } try { this.sock && this.sock.close(); } catch (_) {} this.sock = null; this.remoteIp = null; this.txQueue = []; this.rxMap.clear(); this.rxNext = -1; }
}

// cfg: { serviceHost, servicePort, realm, ext, secret, displayName }
class InboundPhone extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg || {};
    this.localIp = primaryIPv4();
    this.sock = null; this.localPort = 0;
    this.registered = false; this.regCseq = 1; this.regTimer = null; this.regAuthTries = 0;
    this.callId = rnd(8) + '@' + this.localIp;
    this.fromTag = rnd(6);
    this._reregTimer = null; this._kaTimer = null;
    this._regConfirm = null; this._refreshTries = 0; this._refreshMs = 15000; // fast-retry for an unconfirmed refresh
    // Keep trying to register until it succeeds (recovers after the service
    // restarts, the firewall opens, or a packet is lost) instead of giving up.
    this.on('registerFailed', () => this._retryLater());
    this.on('registered', () => {
      if (this._reregTimer) { clearTimeout(this._reregTimer); this._reregTimer = null; }
      this._startKeepalive();
    });
    this.call = null; // active/ringing call dialog
  }
  _dbg(t) { this.emit('debug', t); }
  start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', () => {});
    this.sock.on('message', (buf, rinfo) => this._onMsg(buf.toString('utf8'), rinfo));
    this.sock.bind(() => { this.localPort = this.sock.address().port; this.register(); });
  }
  stop() {
    if (this.regTimer) clearTimeout(this.regTimer);
    if (this._reregTimer) { clearTimeout(this._reregTimer); this._reregTimer = null; }
    if (this._regConfirm) { clearTimeout(this._regConfirm); this._regConfirm = null; }
    if (this._kaTimer) { clearInterval(this._kaTimer); this._kaTimer = null; }
    this._stopped = true;
    try { this.register(0); } catch (_) {}
    if (this.call) { try { this.hangup(); } catch (_) {} }
    try { this.sock && this.sock.close(); } catch (_) {}
    this.sock = null; this.registered = false;
  }
  _retryLater() {
    if (this._stopped || !this.sock || this._reregTimer) return;
    this.emit('status', 'registration will retry in 5s…');
    this._reregTimer = setTimeout(() => { this._reregTimer = null; if (!this._stopped && this.sock) this.register(); }, 5000);
  }
  // A periodic registration REFRESH that survives a dropped packet without waiting
  // a whole cycle: it sends a REGISTER and, if no 2xx comes back within 5s, resends
  // quickly a few times. Runs even while we still believe we're registered, because
  // the goal is to keep the SERVICE's binding alive (so it never expires us and
  // routes calls elsewhere), not just our local flag.
  _refresh() {
    this._refreshTries = 0;
    this.register();
    this._armRegConfirm();
  }
  _armRegConfirm() {
    if (this._regConfirm) clearTimeout(this._regConfirm);
    this._regConfirm = setTimeout(() => {
      this._regConfirm = null;
      if (this._stopped || !this.sock) return;
      if ((this._refreshTries || 0) >= 4) {
        // Still no reply after several fast retries — the link is likely down. DO
        // NOT stop: the refresh loop only re-arms on a successful 2xx, so bailing
        // here left the phone "on" but PERMANENTLY offline (no more REGISTERs sent)
        // until an app restart — even after the connection came back. Keep a
        // heartbeat going so we re-register the instant the link returns.
        this.emit('status', 'registration unreachable — will keep retrying');
        if (this.regTimer) clearTimeout(this.regTimer);
        this.regTimer = setTimeout(() => this._refresh(), this._refreshMs || 15000);
        return;
      }
      this._refreshTries++;
      this.emit('status', 'REGISTER refresh unconfirmed — fast retry ' + this._refreshTries);
      this.register();
      this._armRegConfirm();
    }, 5000);
  }
  // Send a tiny CRLF keepalive to the service every 25s so the router keeps this
  // phone's NAT pinhole open — otherwise inbound calls can't reach us between
  // the (infrequent) SIP re-registrations.
  _startKeepalive() {
    if (this._kaTimer || this._stopped) return;
    this._kaTimer = setInterval(() => {
      try { this.sock && this.sock.send(Buffer.from('\r\n\r\n'), this.cfg.servicePort, this.cfg.serviceHost); } catch (_) {}
    }, 25000);
  }
  _send(msg) { try { this.sock.send(Buffer.from(msg), this.cfg.servicePort, this.cfg.serviceHost); } catch (_) {} }
  _via(branch) { return `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=z9hG4bK${branch};rport`; }
  _contact() { return `<sip:${this.cfg.ext}@${this.localIp}:${this.localPort}>`; }

  // ---- REGISTER to the queue service ----
  register(expires) {
    const exp = expires === undefined ? 3600 : expires;
    this._pendingExp = exp;
    this._sendRegister(exp, null);
  }
  _sendRegister(exp, auth) {
    const c = this.cfg;
    const uri = `sip:${c.serviceHost}`;
    const cseq = this.regCseq++;
    if (!auth) this.emit('status', 'registering to ' + c.serviceHost + ':' + c.servicePort + ' as ' + c.ext + '…');
    if (this._regWatch) clearTimeout(this._regWatch);
    this._regWatch = setTimeout(() => {
      if (!this.registered) this.emit('registerFailed', 'no response from queue service at ' + c.serviceHost + ':' + c.servicePort + ' — check it is running and UDP ' + c.servicePort + ' is open');
    }, 6000);
    const lines = [
      `REGISTER ${uri} SIP/2.0`,
      this._via(rnd(8)),
      `Max-Forwards: 70`,
      `From: "${c.displayName || c.ext}" <sip:${c.ext}@${c.realm || c.serviceHost}>;tag=${this.fromTag}`,
      `To: <sip:${c.ext}@${c.realm || c.serviceHost}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} REGISTER`,
      `Contact: ${this._contact()}`,
      `Expires: ${exp}`,
      `Allow: INVITE, ACK, CANCEL, BYE, INFO, OPTIONS`,
      `User-Agent: EmplPortalInbound/${c.version || '0'}`,
      auth || null,
      `Content-Length: 0`, '', '',
    ].filter((x) => x !== null);
    this._send(lines.join('\r\n'));
  }
  _onRegisterResp(msg) {
    if (this._regWatch) { clearTimeout(this._regWatch); this._regWatch = null; }
    if (msg.status === 401 || msg.status === 403) {
      if (msg.status === 403 || ++this.regAuthTries > 3) { this.registered = false; this.emit('registerFailed', 'auth rejected'); this.regAuthTries = 0; return; }
      const h = msg.headers['www-authenticate']; if (!h) return this.emit('registerFailed', 'no challenge');
      const ch = parseAuth(h);
      const uri = `sip:${this.cfg.serviceHost}`;
      const ha1 = md5(`${this.cfg.ext}:${ch.realm}:${this.cfg.secret}`);
      const ha2 = md5(`REGISTER:${uri}`);
      const nc = '00000001', cnonce = rnd(8);
      const resp = ch.qop ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${ch.nonce}:${ha2}`);
      let a = `Authorization: Digest username="${this.cfg.ext}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${resp}"`;
      if (ch.algorithm) a += `, algorithm=${ch.algorithm}`;
      if (ch.qop) a += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
      this._sendRegister(this._pendingExp, a);
      return;
    }
    if (msg.status >= 200 && msg.status < 300) {
      this.regAuthTries = 0;
      // A refresh landed — clear its fast-retry watchdog and reset the counter.
      this._refreshTries = 0;
      if (this._regConfirm) { clearTimeout(this._regConfirm); this._regConfirm = null; }
      if (this._pendingExp === 0) { this.registered = false; return; }
      if (!this.registered) { this.registered = true; this.emit('registered'); }
      let granted = 3600; const eh = (msg.headers['expires'] || '').trim();
      if (/^\d+$/.test(eh)) granted = parseInt(eh, 10); else { const m = /expires=(\d+)/i.exec(msg.headers['contact'] || ''); if (m) granted = parseInt(m[1], 10); }
      // Re-register FAR below the granted lifetime (cap 25s) so a lost REGISTER is
      // never fatal: with a 120s service expiry that's ~4 tries before it could
      // lapse. Half-the-lifetime (60s) left only one try and let agents on mobile/
      // CGNAT links (changing ports, packet loss) drop off mid-call. The fast-retry
      // below recovers a dropped refresh within ~5s on top of this.
      const refreshMs = Math.max(8, Math.min(Math.floor(granted * 0.5), 25)) * 1000;
      this._refreshMs = refreshMs; // remembered so the heartbeat can keep going even when a refresh fails
      if (this.regTimer) clearTimeout(this.regTimer);
      this.regTimer = setTimeout(() => this._refresh(), refreshMs);
      return;
    }
    if (msg.status >= 400) this.emit('registerFailed', msg.status + ' ' + msg.reason);
  }

  // ---- incoming call (INVITE from the service) ----
  _onInvite(msg, rinfo) {
    if (this.call) { this._respond(msg, rinfo, 486, 'Busy Here'); return; } // already on a call
    const offer = parseSdp(msg.body);
    if (!offer) { this._respond(msg, rinfo, 488, 'Not Acceptable Here'); return; }
    const caller = (msg.headers['x-caller'] || '').trim() || ((/sip:([^@]+)@/.exec(msg.headers['from'] || '') || [])[1] || 'unknown');
    let via = '';
    try { via = decodeURIComponent((msg.headers['x-via-name'] || '').trim()); } catch (_) { via = (msg.headers['x-via-name'] || '').trim(); }
    this.call = {
      callId: msg.headers['call-id'], inviteReq: msg, rinfo,
      fromHdr: msg.headers['from'], toHdr: msg.headers['to'], cseqHdr: msg.headers['cseq'], viaHdr: msg.headers['via'],
      toTag: rnd(6), offer, rtp: null, answered: false, caller, via, muted: false, onhold: false, infoCseq: 1,
    };
    this._respond(msg, rinfo, 180, 'Ringing', [`Contact: ${this._contact()}`]);
    this.emit('incoming', { caller, via });
  }
  answer() {
    const c = this.call; if (!c || c.answered) return;
    const rtp = new Rtp(this.localIp);
    rtp.open(() => {
      rtp.setRemote(c.offer.ip, c.offer.port, c.offer.payload);
      rtp.onPcm = (pcm) => this.emit('audio', pcm);
      c.rtp = rtp; c.answered = true;
      const pt = c.offer.payload === 8 ? 8 : 0;
      const map = pt === 8 ? 'a=rtpmap:8 PCMA/8000' : 'a=rtpmap:0 PCMU/8000';
      const sdp = ['v=0', `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.localIp}`, 's=-', `c=IN IP4 ${this.localIp}`, 't=0 0', `m=audio ${rtp.localPort} RTP/AVP ${pt} 101`, map, 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n');
      const lines = [
        'SIP/2.0 200 OK', 'Via: ' + c.viaHdr, 'From: ' + c.fromHdr,
        'To: ' + c.toHdr + ';tag=' + c.toTag, 'Call-ID: ' + c.callId, 'CSeq: ' + c.cseqHdr,
        'Contact: ' + this._contact(), 'Content-Type: application/sdp', 'User-Agent: EmplPortalInbound/1.0',
        'Content-Length: ' + Buffer.byteLength(sdp), '', sdp,
      ];
      this._send(lines.join('\r\n'));
      rtp.startSending();
      this.emit('answered', { caller: c.caller, via: c.via });
    });
  }
  reject() { const c = this.call; if (!c) return; this._respond(c.inviteReq, c.rinfo, 603, 'Decline'); this._endLocal('rejected'); }
  writeMic(pcm) { const c = this.call; if (c && c.rtp && c.answered && !c.onhold) c.rtp.writePcm(pcm); }
  mute(on) { const c = this.call; if (c && c.rtp) c.rtp.muted = !!on; }
  hold(on) { const c = this.call; if (!c) return; c.onhold = !!on; this._sendInfo({ action: on ? 'hold' : 'unhold' }); }
  transfer(uid) { const c = this.call; if (!c) return; this._sendInfo({ action: 'transfer', uid: Number(uid) }); }
  hangup() {
    const c = this.call; if (!c) return;
    if (c.answered) {
      const target = (/<([^>]+)>/.exec(c.fromHdr) || [])[1] || (/sip:[^;>]+/.exec(c.fromHdr) || [])[0];
      const lines = [
        `BYE ${target} SIP/2.0`, this._via(rnd(8)), 'Max-Forwards: 70',
        'From: ' + c.toHdr + ';tag=' + c.toTag, 'To: ' + c.fromHdr,
        'Call-ID: ' + c.callId, `CSeq: ${++c.infoCseq} BYE`, 'Content-Length: 0', '', '',
      ];
      this._send(lines.join('\r\n'));
    } else {
      this._respond(c.inviteReq, c.rinfo, 486, 'Busy Here');
    }
    this._endLocal('hangup');
  }
  _sendInfo(obj) {
    const c = this.call; if (!c || !c.answered) return;
    const body = JSON.stringify(obj);
    const target = (/<([^>]+)>/.exec(c.fromHdr) || [])[1] || `sip:queue@${this.cfg.serviceHost}`;
    const lines = [
      `INFO ${target} SIP/2.0`, this._via(rnd(8)), 'Max-Forwards: 70',
      'From: ' + c.toHdr + ';tag=' + c.toTag, 'To: ' + c.fromHdr,
      'Call-ID: ' + c.callId, `CSeq: ${++c.infoCseq} INFO`,
      'Content-Type: application/json', 'Content-Length: ' + Buffer.byteLength(body), '', body,
    ];
    this._send(lines.join('\r\n'));
  }
  _endLocal(why) { const c = this.call; if (!c) return; if (c.rtp) c.rtp.close(); this.call = null; this.emit('ended', { reason: why }); }

  _respond(req, rinfo, code, reason, extra) {
    const lines = [
      `SIP/2.0 ${code} ${reason}`, 'Via: ' + (req.headers['via'] || ''),
      'From: ' + (req.headers['from'] || ''),
      'To: ' + (req.headers['to'] || '') + (code >= 200 && !/tag=/.test(req.headers['to'] || '') && this.call ? ';tag=' + this.call.toTag : ''),
      'Call-ID: ' + (req.headers['call-id'] || ''), 'CSeq: ' + (req.headers['cseq'] || ''),
    ].concat(extra || []).concat(['Content-Length: 0', '', '']);
    try { this.sock.send(Buffer.from(lines.join('\r\n')), rinfo.port, rinfo.address); } catch (_) {}
  }

  _onMsg(str, rinfo) {
    if (!/SIP\/2\.0/.test(str)) return;
    const msg = parseMsg(str);
    if (msg.status !== null) {
      const cseq = (msg.headers['cseq'] || '').toUpperCase();
      if (/REGISTER/.test(cseq)) return this._onRegisterResp(msg);
      return; // responses to our BYE/INFO: ignore
    }
    const method = msg.method;
    if (method === 'INVITE') {
      if (!/tag=/.test(msg.headers['to'] || '')) return this._onInvite(msg, rinfo);
      this._respond(msg, rinfo, 200, 'OK'); return; // re-INVITE keep-alive
    }
    if (method === 'ACK') return;
    if (method === 'OPTIONS') { this._respond(msg, rinfo, 200, 'OK'); return; }
    if (method === 'BYE') {
      this._respond(msg, rinfo, 200, 'OK');
      if (this.call && this.call.callId === msg.headers['call-id']) {
        // The service tells us who ended it via X-Ended-By so the UI can say so.
        const by = (msg.headers['x-ended-by'] || '').trim();
        this._endLocal(by === 'customer' ? 'customer-hangup' : 'remote hangup');
      }
      return;
    }
    if (method === 'CANCEL') {
      this._respond(msg, rinfo, 200, 'OK');
      if (this.call && !this.call.answered) { this._respond(this.call.inviteReq, this.call.rinfo, 487, 'Request Terminated'); this._endLocal('canceled'); }
      return;
    }
    if (method === 'INFO') { this._respond(msg, rinfo, 200, 'OK'); return; }
    this._respond(msg, rinfo, 200, 'OK');
  }
}

module.exports = { InboundPhone };
