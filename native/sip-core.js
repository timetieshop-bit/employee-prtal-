// Native SIP/UDP + RTP softphone engine (main process). Speaks SIP directly to a
// raw trunk over UDP (REGISTER with digest auth, INVITE/SDP/ACK/BYE) and carries
// G.711 audio over RTP — no WebRTC, no WSS, no media server. Audio PCM is bridged
// to/from the renderer window. Outbound calling only.
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const g711 = require('./g711.js');

const rnd = (n) => crypto.randomBytes(n).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function primaryIPv4() {
  const ifs = os.networkInterfaces();
  let best = '127.0.0.1';
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name]) {
      if (a.family === 'IPv4' && !a.internal) {
        if (!/^169\.254\./.test(a.address)) return a.address;
        best = a.address;
      }
    }
  }
  return best;
}

// --- minimal SIP message parser ---
function parseMsg(str) {
  const idx = str.indexOf('\r\n\r\n');
  const head = idx >= 0 ? str.slice(0, idx) : str;
  const body = idx >= 0 ? str.slice(idx + 4) : '';
  const lines = head.split('\r\n');
  const first = lines.shift();
  const headers = {};
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c < 0) continue;
    const k = line.slice(0, c).trim().toLowerCase();
    const v = line.slice(c + 1).trim();
    if (headers[k] === undefined) headers[k] = v;
    else headers[k] += ',' + v;
  }
  const m = /^SIP\/2\.0\s+(\d+)\s+(.*)$/.exec(first);
  return { first, status: m ? parseInt(m[1], 10) : null, reason: m ? m[2] : '', headers, body, raw: str };
}

function parseAuth(h) {
  // WWW-Authenticate / Proxy-Authenticate "Digest realm=..., nonce=..., qop=..."
  const out = { scheme: 'Digest' };
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g; let m;
  while ((m = re.exec(h))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

class SipPhone extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg; // {server, port, user, authUser, password, domain, displayName, callerId}
    // SIP URIs can't contain spaces/parentheses, so normalize a formatted number
    // like "+1 (231) 999-9091" into "+12319999091" for the From/To/Contact user.
    this.user = String(cfg.user || '').replace(/[\s()\-.]/g, '');
    this.authUser = (cfg.authUser && String(cfg.authUser).trim()) ? String(cfg.authUser).trim() : this.user;
    this.localIp = primaryIPv4();
    this.sock = null;
    this.rtp = null;
    this.registered = false;
    this.callId = null;     // current INVITE dialog Call-ID
    this.regCallId = rnd(8) + '@' + this.localIp;
    this.cseq = { REGISTER: 1, INVITE: 1, BYE: 1, INFO: 1 };
    this.fromTag = rnd(6);
    this.dialog = null;     // active call dialog state
    this.regTimer = null;
    this.pendingAuth = {};  // last auth challenge per method
  }

  // ---------- transport ----------
  start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf, rinfo) => this._onSip(buf.toString('utf8'), rinfo));
    const onBound = () => {
      this.localPort = this.sock.address().port;
      this.emit('status', 'bound udp ' + this.localIp + ':' + this.localPort);
      this._regAuthTries = 0;
      this._armRegWatchdog();
      this.register();
    };
    // Prefer local port 5060 (what softphones like eyeBeam/X-Lite use). Many
    // trunks reply to the port in the Via header rather than honoring rport, so
    // a random ephemeral port can get no response at all. If 5060 is already in
    // use, fall back to an OS-assigned port.
    const bindFallback = () => {
      try { this.sock.removeAllListeners('error'); } catch (_) {}
      this.sock = dgram.createSocket('udp4');
      this.sock.on('message', (buf, rinfo) => this._onSip(buf.toString('utf8'), rinfo));
      this.sock.on('error', (e) => this.emit('status', 'socket error: ' + e.message));
      this.sock.bind(onBound);
    };
    this.sock.once('error', bindFallback);
    try {
      this.sock.bind(5060, () => {
        this.sock.removeListener('error', bindFallback);
        this.sock.on('error', (e) => this.emit('status', 'socket error: ' + e.message));
        onBound();
      });
    } catch (_) { bindFallback(); }
  }
  // If the trunk never answers REGISTER (UDP blocked, wrong server/port, or the
  // trunk is silent), don't leave the UI stuck on "Connecting…" forever. One
  // retry, then surface a clear failure.
  _armRegWatchdog() {
    if (this._regWatch) clearTimeout(this._regWatch);
    this._regWatch = setTimeout(() => {
      if (this.registered) return;
      if ((this._regRetries || 0) < 1) {
        this._regRetries = (this._regRetries || 0) + 1;
        this.emit('status', 'no response — retrying REGISTER');
        this._armRegWatchdog();
        this.register();
      } else {
        this.emit('registerFailed', 'no response from trunk (check server, port, firewall/UDP)');
      }
    }, 8000);
  }
  _clearRegWatch() { if (this._regWatch) { clearTimeout(this._regWatch); this._regWatch = null; } }
  _send(msg) {
    try { this.sock.send(Buffer.from(msg, 'utf8'), this.cfg.port || 5060, this.cfg.server); } catch (_) {}
  }
  stop() {
    this.hangup();
    this._clearRegWatch();
    if (this.regTimer) clearInterval(this.regTimer);
    if (this.registered) this._sendRegister(0); // unregister
    setTimeout(() => { try { this.sock && this.sock.close(); } catch (_) {} }, 150);
    this.registered = false;
  }

  // ---------- helpers ----------
  _via(branch) { return `SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=z9hG4bK${branch};rport`; }
  _contact() { return `<sip:${this.user}@${this.localIp}:${this.localPort}>`; }
  _aor() { return `sip:${this.user}@${this.cfg.domain}`; }

  _authHeader(method, uri, challenge, headerName) {
    const user = this.authUser;
    const ha1 = md5(`${user}:${challenge.realm}:${this.cfg.password}`);
    const ha2 = md5(`${method}:${uri}`);
    let response, extra = '';
    if (challenge.qop) {
      const nc = '00000001'; const cnonce = rnd(8);
      response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
      extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    } else {
      response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }
    const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : '';
    const algo = challenge.algorithm ? `, algorithm=${challenge.algorithm}` : '';
    return `${headerName}: Digest username="${user}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"${algo}${opaque}${extra}`;
  }

  // ---------- REGISTER ----------
  register() { this._regAuthTries = 0; this._sendRegister(300); }
  _sendRegister(expires, auth) {
    const branch = rnd(8);
    const uri = `sip:${this.cfg.domain}`;
    const cseq = this.cseq.REGISTER++;
    let lines = [
      `REGISTER ${uri} SIP/2.0`,
      this._via(branch),
      `Max-Forwards: 70`,
      `From: <${this._aor()}>;tag=${this.fromTag}`,
      `To: <${this._aor()}>`,
      `Call-ID: ${this.regCallId}`,
      `CSeq: ${cseq} REGISTER`,
      `Contact: ${this._contact()}`,
      `Expires: ${expires}`,
      `User-Agent: EmployeePortalPhone`,
    ];
    if (auth) lines.push(auth);
    lines.push('Content-Length: 0', '', '');
    this._regBranch = branch; this._regExpires = expires;
    this._send(lines.join('\r\n'));
  }

  // ---------- INVITE (outbound call) ----------
  call(number) {
    const dest = String(number).replace(/[^\d+*#]/g, '');
    if (!dest) return;
    this.hangup(); // one call at a time
    this.rtp = new RtpSession(this.localIp, (pcm) => this.emit('audio', pcm));
    this.rtp.open(() => {
      this.dialog = {
        number: dest, callId: rnd(10) + '@' + this.localIp, branch: rnd(8),
        cseq: this.cseq.INVITE++, toTag: null, state: 'calling',
        uri: `sip:${dest}@${this.cfg.domain}`,
      };
      this.callId = this.dialog.callId;
      this._sendInvite();
      this.emit('status', 'calling ' + dest);
    });
  }
  _sendInvite(auth) {
    const d = this.dialog; if (!d) return;
    const fromUser = this.cfg.callerId ? this.cfg.callerId.replace(/[^\d+]/g, '') : this.user;
    const sdp = this.rtp.offerSdp();
    let lines = [
      `INVITE ${d.uri} SIP/2.0`,
      this._via(d.branch),
      `Max-Forwards: 70`,
      `From: "${this.cfg.displayName || fromUser}" <sip:${fromUser}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: <${d.uri}>`,
      `Call-ID: ${d.callId}`,
      `CSeq: ${d.cseq} INVITE`,
      `Contact: ${this._contact()}`,
      `User-Agent: EmployeePortalPhone`,
      `Content-Type: application/sdp`,
    ];
    if (auth) lines.push(auth);
    lines.push(`Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp);
    this._send(lines.join('\r\n'));
  }
  _sendAck(d, toTagLine, uri) {
    // ACK for a 2xx uses a new branch; for non-2xx reuse INVITE branch.
    const lines = [
      `ACK ${uri} SIP/2.0`,
      this._via(d.ackBranch || d.branch),
      `Max-Forwards: 70`,
      `From: <sip:${this.user}@${this.cfg.domain}>;tag=${this.fromTag}`,
      toTagLine,
      `Call-ID: ${d.callId}`,
      `CSeq: ${d.cseq} ACK`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
  }

  // ---------- hangup ----------
  hangup() {
    const d = this.dialog;
    if (this.rtp) { this.rtp.close(); this.rtp = null; }
    if (!d) return;
    if (d.state === 'answered') this._sendBye(d);
    else if (d.state === 'calling' || d.state === 'ringing') this._sendCancel(d);
    this.dialog = null; this.callId = null;
  }
  _sendBye(d, auth) {
    const cseq = this.cseq.BYE++;
    const lines = [
      `BYE ${d.remoteTarget || d.uri} SIP/2.0`,
      this._via(rnd(8)),
      `Max-Forwards: 70`,
      `From: <sip:${this.user}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: <${d.uri}>` + (d.toTag ? `;tag=${d.toTag}` : ''),
      `Call-ID: ${d.callId}`,
      `CSeq: ${cseq} BYE`,
    ];
    if (auth) lines.push(auth);
    lines.push('Content-Length: 0', '', '');
    d._byeCseq = cseq;
    this._send(lines.join('\r\n'));
  }
  _sendCancel(d) {
    const lines = [
      `CANCEL ${d.uri} SIP/2.0`,
      this._via(d.branch),
      `Max-Forwards: 70`,
      `From: <sip:${this.user}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: <${d.uri}>`,
      `Call-ID: ${d.callId}`,
      `CSeq: ${d.cseq} CANCEL`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
  }

  // ---------- DTMF via SIP INFO ----------
  sendDtmf(digits) {
    const d = this.dialog; if (!d || d.state !== 'answered') return;
    for (const dg of String(digits).replace(/[^0-9*#A-Da-d]/g, '')) {
      const body = `Signal=${dg}\r\nDuration=160\r\n`;
      const cseq = this.cseq.INFO++;
      const lines = [
        `INFO ${d.remoteTarget || d.uri} SIP/2.0`,
        this._via(rnd(8)),
        `Max-Forwards: 70`,
        `From: <sip:${this.user}@${this.cfg.domain}>;tag=${this.fromTag}`,
        `To: <${d.uri}>` + (d.toTag ? `;tag=${d.toTag}` : ''),
        `Call-ID: ${d.callId}`,
        `CSeq: ${cseq} INFO`,
        `Content-Type: application/dtmf-relay`,
        `Content-Length: ${Buffer.byteLength(body)}`, '', body,
      ];
      this._send(lines.join('\r\n'));
    }
  }

  writeMic(pcm) { if (this.rtp) this.rtp.writePcm(pcm); }
  mute(on) { if (this.rtp) this.rtp.muted = !!on; }

  // ---------- incoming SIP ----------
  _onSip(str) {
    const msg = parseMsg(str);
    // Incoming requests (BYE, OPTIONS)
    if (msg.status === null) { this._onRequest(msg); return; }

    const cseqH = msg.headers['cseq'] || '';
    const method = (cseqH.split(/\s+/)[1] || '').toUpperCase();

    if (method === 'REGISTER') return this._onRegisterResp(msg);
    if (method === 'INVITE') return this._onInviteResp(msg, cseqH);
    if (method === 'BYE' || method === 'CANCEL' || method === 'INFO') return; // acks of our requests
  }

  _onRegisterResp(msg) {
    if (msg.status === 401 || msg.status === 407) {
      // Guard against an endless auth loop when credentials are wrong: the trunk
      // keeps answering 401 to every signed REGISTER. Try once (occasionally
      // twice for a stale nonce), then give a clear "rejected" failure.
      this._regAuthTries = (this._regAuthTries || 0) + 1;
      if (this._regAuthTries > 2) {
        this._clearRegWatch();
        return this.emit('registerFailed', 'auth rejected — check username / auth username / password');
      }
      const h = msg.headers['www-authenticate'] || msg.headers['proxy-authenticate'];
      if (!h) { this._clearRegWatch(); return this.emit('registerFailed', 'no auth header'); }
      const ch = parseAuth(h);
      const hdr = msg.status === 407 ? 'Proxy-Authorization' : 'Authorization';
      const auth = this._authHeader('REGISTER', `sip:${this.cfg.domain}`, ch, hdr);
      this._sendRegister(this._regExpires, auth);
      return;
    }
    if (msg.status >= 200 && msg.status < 300) {
      this._clearRegWatch();
      this._regAuthTries = 0; this._regRetries = 0;
      if (this._regExpires === 0) { this.registered = false; return; }
      if (!this.registered) { this.registered = true; this.emit('registered'); }
      if (this.regTimer) clearInterval(this.regTimer);
      this.regTimer = setInterval(() => this.register(), 250 * 1000); // refresh < 300s
      return;
    }
    if (msg.status >= 400) { this._clearRegWatch(); this.emit('registerFailed', msg.status + ' ' + (msg.reason || '')); }
  }

  _onInviteResp(msg, cseqH) {
    const d = this.dialog; if (!d) return;
    // capture To-tag
    const toH = msg.headers['to'] || '';
    const tt = /tag=([^;>\s]+)/.exec(toH); if (tt) d.toTag = tt[1];

    if (msg.status === 401 || msg.status === 407) {
      // ACK the challenge, then re-INVITE with auth.
      this._ackNonOk(d, msg);
      const h = msg.headers['www-authenticate'] || msg.headers['proxy-authenticate'];
      const ch = parseAuth(h || '');
      const hdr = msg.status === 407 ? 'Proxy-Authorization' : 'Authorization';
      d.branch = rnd(8); d.cseq = this.cseq.INVITE++;
      this._sendInvite(this._authHeader('INVITE', d.uri, ch, hdr));
      return;
    }
    if (msg.status === 100) return;
    if (msg.status === 180 || msg.status === 183) {
      if (d.state === 'calling') { d.state = 'ringing'; this.emit('ringing'); }
      return;
    }
    if (msg.status >= 200 && msg.status < 300) {
      // Parse SDP answer, ACK, start media.
      const remote = parseSdp(msg.body);
      const ct = /<([^>]+)>/.exec(msg.headers['contact'] || '');
      d.remoteTarget = ct ? ct[1] : d.uri;
      d.ackBranch = rnd(8);
      const toTagLine = `To: <${d.uri}>` + (d.toTag ? `;tag=${d.toTag}` : '');
      this._sendAck(d, toTagLine, d.remoteTarget);
      if (remote && this.rtp) {
        this.rtp.setRemote(remote.ip, remote.port, remote.payload);
        this.rtp.startSending();
      }
      if (d.state !== 'answered') { d.state = 'answered'; this.emit('answered'); }
      return;
    }
    if (msg.status >= 300) {
      this._ackNonOk(d, msg);
      this.emit('failed', msg.status + ' ' + msg.reason);
      if (this.rtp) { this.rtp.close(); this.rtp = null; }
      this.dialog = null;
    }
  }
  _ackNonOk(d, msg) {
    const toH = msg.headers['to'] || `<${d.uri}>`;
    const lines = [
      `ACK ${d.uri} SIP/2.0`,
      this._via(d.branch),
      `Max-Forwards: 70`,
      `From: <sip:${this.user}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: ${toH.replace(/^To:\s*/i, '')}`,
      `Call-ID: ${d.callId}`,
      `CSeq: ${d.cseq} ACK`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
  }

  _onRequest(msg) {
    const method = (msg.first.split(/\s+/)[0] || '').toUpperCase();
    const resp200 = (extra) => {
      const lines = [
        'SIP/2.0 200 OK',
        'Via: ' + (msg.headers['via'] || ''),
        'From: ' + (msg.headers['from'] || ''),
        'To: ' + (msg.headers['to'] || ''),
        'Call-ID: ' + (msg.headers['call-id'] || ''),
        'CSeq: ' + (msg.headers['cseq'] || ''),
      ].concat(extra || []).concat(['Content-Length: 0', '', '']);
      this._send(lines.join('\r\n'));
    };
    if (method === 'OPTIONS') return resp200(['Contact: ' + this._contact()]);
    if (method === 'BYE') {
      resp200();
      if (this.rtp) { this.rtp.close(); this.rtp = null; }
      this.dialog = null; this.callId = null;
      this.emit('ended', 'remote hangup');
      return;
    }
    if (method === 'INFO' || method === 'NOTIFY') return resp200();
    if (method === 'ACK') return; // nothing
    // Unknown request: 200 to be polite
    resp200();
  }
}

// --- SDP parse (answer) ---
function parseSdp(body) {
  if (!body) return null;
  let ip = null, port = null, payload = 0;
  const mline = /m=audio\s+(\d+)\s+RTP\/AVP\s+([\d\s]+)/.exec(body);
  if (mline) { port = parseInt(mline[1], 10); const pts = mline[2].trim().split(/\s+/).map(Number); payload = pts.includes(0) ? 0 : (pts.includes(8) ? 8 : pts[0]); }
  const cline = /c=IN IP4\s+([\d.]+)/.exec(body);
  if (cline) ip = cline[1];
  if (!port || !ip) return null;
  return { ip, port, payload };
}

// --- RTP session (G.711) ---
class RtpSession {
  constructor(localIp, onPcm) {
    this.localIp = localIp; this.onPcm = onPcm;
    this.sock = null; this.localPort = 0;
    this.remoteIp = null; this.remotePort = 0; this.payload = 0; // 0=PCMU 8=PCMA
    this.seq = Math.floor(Math.random() * 65535);
    this.ts = Math.floor(Math.random() * 2 ** 31);
    this.ssrc = Math.floor(Math.random() * 2 ** 31);
    this.txQueue = []; this.txTimer = null; this.muted = false;
  }
  open(cb) {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf) => this._recv(buf));
    this.sock.on('error', () => {});
    // Bind an even port (RTP convention)
    const tryBind = () => {
      const p = 10000 + (Math.floor(Math.random() * 10000) * 2 % 20000); // even-ish
      this.sock.bind(p, () => { this.localPort = this.sock.address().port; cb && cb(); });
    };
    this.sock.once('error', () => { try { this.sock.close(); } catch (_) {} this.sock = dgram.createSocket('udp4'); this.sock.on('message', (buf) => this._recv(buf)); this.sock.bind(() => { this.localPort = this.sock.address().port; cb && cb(); }); });
    tryBind();
  }
  offerSdp() {
    const sid = Math.floor(Math.random() * 1e9);
    return [
      'v=0',
      `o=- ${sid} ${sid} IN IP4 ${this.localIp}`,
      's=-',
      `c=IN IP4 ${this.localIp}`,
      't=0 0',
      `m=audio ${this.localPort} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=sendrecv', '',
    ].join('\r\n');
  }
  setRemote(ip, port, payload) { this.remoteIp = ip; this.remotePort = port; this.payload = payload === 8 ? 8 : 0; }
  writePcm(pcm) { // Int16Array, 8kHz mono; chunked into 160-sample frames
    if (!this.remoteIp) return;
    this.txQueue.push(pcm);
  }
  startSending() {
    if (this.txTimer) return;
    let carry = new Int16Array(0);
    this.txTimer = setInterval(() => {
      // assemble 160-sample (20ms) frame
      let need = 160;
      let frame = new Int16Array(160);
      let off = 0;
      // prepend carry
      if (carry.length) { const n = Math.min(carry.length, need); frame.set(carry.subarray(0, n), 0); off = n; carry = carry.subarray(n); }
      while (off < 160 && this.txQueue.length) {
        const q = this.txQueue[0];
        const n = Math.min(q.length, 160 - off);
        frame.set(q.subarray(0, n), off); off += n;
        if (n < q.length) { this.txQueue[0] = q.subarray(n); } else this.txQueue.shift();
      }
      // if underrun, rest stays zero (silence)
      if (this.muted) frame = new Int16Array(160);
      this._sendFrame(frame);
    }, 20);
  }
  _sendFrame(pcm) {
    if (!this.remoteIp) return;
    const enc = this.payload === 8 ? g711.encodeAlaw(pcm) : g711.encodeUlaw(pcm);
    const pkt = Buffer.allocUnsafe(12 + enc.length);
    pkt[0] = 0x80; pkt[1] = this.payload & 0x7f;
    pkt.writeUInt16BE(this.seq & 0xffff, 2); this.seq = (this.seq + 1) & 0xffff;
    pkt.writeUInt32BE(this.ts >>> 0, 4); this.ts = (this.ts + 160) >>> 0;
    pkt.writeUInt32BE(this.ssrc >>> 0, 8);
    enc.copy(pkt, 12);
    try { this.sock.send(pkt, this.remotePort, this.remoteIp); } catch (_) {}
  }
  _recv(buf) {
    if (buf.length < 12) return;
    const pt = buf[1] & 0x7f;
    const payload = buf.subarray(12);
    let pcm;
    if (pt === 8) pcm = g711.decodeAlaw(payload);
    else if (pt === 0) pcm = g711.decodeUlaw(payload);
    else return; // ignore DTMF/comfort-noise payloads
    if (this.onPcm) this.onPcm(pcm);
  }
  close() {
    if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; }
    try { this.sock && this.sock.close(); } catch (_) {}
    this.sock = null; this.remoteIp = null; this.txQueue = [];
  }
}

module.exports = { SipPhone };
