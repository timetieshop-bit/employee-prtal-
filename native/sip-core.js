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

// --- STUN (RFC 5389) public-address discovery ---
// Softphones like eyeBeam put their *public* (post-NAT) address in SIP Via/Contact
// and SDP so a trunk that doesn't honor rport still routes replies/media back.
// Without this, a client behind NAT advertises its private LAN IP and the trunk's
// responses vanish — exactly the "no response from trunk" symptom.
const STUN_MAGIC = 0x2112a442;
function stunRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);         // Binding Request
  buf.writeUInt16BE(0x0000, 2);         // length 0
  buf.writeUInt32BE(STUN_MAGIC, 4);     // magic cookie
  crypto.randomBytes(12).copy(buf, 8);  // transaction id
  return buf;
}
function isStun(buf) {
  return buf.length >= 20 && buf.readUInt32BE(4) === STUN_MAGIC && (buf[0] & 0xc0) === 0;
}
function parseStunMapped(buf) {
  let off = 20;
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    const v = off + 4;
    if ((type === 0x0020 || type === 0x0001) && buf[v + 1] === 0x01) { // (XOR-)MAPPED-ADDRESS, IPv4
      let port = buf.readUInt16BE(v + 2);
      let ip;
      if (type === 0x0020) {
        port ^= (STUN_MAGIC >>> 16);
        const r = (buf.readUInt32BE(v + 4) ^ STUN_MAGIC) >>> 0;
        ip = [(r >>> 24) & 0xff, (r >>> 16) & 0xff, (r >>> 8) & 0xff, r & 0xff].join('.');
      } else {
        ip = [buf[v + 4], buf[v + 5], buf[v + 6], buf[v + 7]].join('.');
      }
      return { ip, port: port & 0xffff };
    }
    off = v + len + ((len % 4) ? 4 - (len % 4) : 0);
  }
  return null;
}
// Discover the public mapping of an already-bound UDP socket. The socket's own
// message handler must forward STUN replies to sock._stunCb (see handlers below).
function stunDiscover(sock, host, port, cb) {
  let done = false;
  const finish = (res) => { if (done) return; done = true; sock._stunCb = null; cb(res); };
  try {
    require('dns').lookup(host, { family: 4 }, (err, addr) => {
      if (err || !addr) return finish(null);
      sock._stunCb = (buf) => finish(parseStunMapped(buf));
      const send = () => { try { sock.send(stunRequest(), port, addr); } catch (_) {} };
      send();
      setTimeout(() => { if (!done) send(); }, 350); // one retry
      setTimeout(() => finish(null), 1200);          // give up → caller uses local IP
    });
  } catch (_) { finish(null); }
}

class SipPhone extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg; // {server, port, user, authUser, password, domain, displayName, callerId}
    // Most trunks (and eyeBeam here) dial bare digits like 18002908206 — a leading
    // "+" makes the trunk's dial-plan miss and silently drop the INVITE. So strip
    // formatting AND the "+" by default. Set keepPlus:true only for a trunk that
    // genuinely wants E.164 with "+".
    this.keepPlus = !!cfg.keepPlus;
    // Match eyeBeam's exact User-Agent (captured from its log) — some trunks only
    // accept known softphone UAs.
    this.ua = (cfg.userAgent && String(cfg.userAgent).trim()) || 'eyeBeam release 1003l stamp 30936';
    // Account identity (From/Contact user) must match EXACTLY how the trunk
    // provisioned it. eyeBeam sends the full "User name" verbatim with only spaces
    // percent-encoded, e.g. "+1 (231) 999-9091" -> "+1%20(231)%20999-9091" (parens,
    // "+" and "-" left literal). Stripping it to bare digits made the trunk not
    // recognize the account and silently drop our INVITE.
    this.user = this._id(cfg.user);
    this.authUser = (cfg.authUser && String(cfg.authUser).trim()) ? String(cfg.authUser).trim() : this.user;
    this.localIp = primaryIPv4();
    // Public (post-NAT) address, learned via STUN at startup. Falls back to local.
    this.pubIp = null; this.pubPort = 0;
    this.stunEnabled = cfg.stun !== false;
    // STUN server may arrive as "host" or "host:port"; blank → public default.
    let sh = (cfg.stunServer && String(cfg.stunServer).trim()) || '';
    let sp = parseInt(cfg.stunPort, 10) || 0;
    if (sh.indexOf(':') !== -1) { const parts = sh.split(':'); sh = parts[0]; sp = parseInt(parts[1], 10) || sp; }
    this.stunHost = sh || 'stun.l.google.com';
    this.stunPort = sp || 19302;
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
  // SIP socket message handler: route STUN replies to the pending discovery
  // callback, everything else to the SIP parser.
  _attachSip(sock) {
    sock.on('message', (buf, rinfo) => {
      if (sock._stunCb && isStun(buf)) { this.emit('debug', '← STUN reply (' + buf.length + 'B)'); sock._stunCb(buf); return; }
      this.emit('debug', '← ' + buf.toString('utf8').split('\r\n')[0] + '  (' + buf.length + 'B from ' + (rinfo ? rinfo.address + ':' + rinfo.port : '?') + ')');
      this._onSip(buf.toString('utf8'));
    });
  }
  start() {
    this.sock = dgram.createSocket('udp4');
    this._attachSip(this.sock);
    this.sock.on('error', (e) => this.emit('status', 'socket error: ' + e.message));
    // Fire once the socket is actually bound. Use the 'listening' event (not a
    // bind callback) so this is reliable for an OS-assigned port.
    this.sock.once('listening', () => {
      this.localPort = this.sock.address().port;
      this.emit('status', 'bound udp ' + this.localIp + ':' + this.localPort);
      this._discoverThenReady();
    });
    // Bind an OS-assigned (ephemeral) port, exactly like eyeBeam — it uses a
    // random high port (e.g. 28156), NOT 5060. Many trunks/SBCs silently DROP
    // SIP arriving from source port 5060 as anti-scanner protection, and the
    // trunk honors rport so it replies to wherever we actually send from.
    try { this.sock.bind(); } catch (e) { this.emit('status', 'bind failed: ' + (e && e.message)); }
  }
  // Learn our public address via STUN (like eyeBeam's Topology tab), then go
  // ready / register. STUN failure is non-fatal — we fall back to the local IP.
  _discoverThenReady() {
    const go = () => this._ready();
    if (!this.stunEnabled) return go();
    this.emit('status', 'discovering public address (STUN ' + this.stunHost + ')…');
    stunDiscover(this.sock, this.stunHost, this.stunPort, (res) => {
      if (res && res.ip) {
        this.pubIp = res.ip; this.pubPort = res.port;
        this.emit('status', 'public address ' + res.ip + ':' + res.port + ' (NAT) — advertising this to the trunk');
      } else {
        this.emit('status', 'STUN gave no answer — using local IP ' + this.localIp + ' (set/check STUN server if calls don’t connect)');
      }
      go();
    });
  }
  _ready() {
    // Outbound-only trunks (eyeBeam-style, "Register with domain" unchecked):
    // never REGISTER. Mark ready right away; each INVITE authenticates itself
    // against the trunk's 401/407 challenge (handled in _onInviteResp).
    if (this.cfg.register === false) {
      this.registered = true;
      this.emit('status', 'ready (outbound-only, local port ' + this.localPort + ', advertising ' + this.advIp() + ':' + this.advPort() + ')');
      this.emit('registered');
      return;
    }
    this._regAuthTries = 0;
    this._armRegWatchdog();
    this.register();
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
    try {
      this.sock.send(Buffer.from(msg, 'utf8'), this.cfg.port || 5060, this.cfg.server);
      this.emit('debug', '→ ' + msg.split('\r\n')[0] + '  (' + Buffer.byteLength(msg) + 'B → ' + this.cfg.server + ':' + (this.cfg.port || 5060) + ')');
    } catch (e) { this.emit('debug', '→ SEND FAILED: ' + (e && e.message)); }
  }
  stop() {
    this.hangup();
    this._clearRegWatch();
    if (this.regTimer) clearInterval(this.regTimer);
    // Only un-REGISTER if we actually registered (not in outbound-only mode).
    if (this.registered && this.cfg.register !== false) this._sendRegister(0); // unregister
    setTimeout(() => { try { this.sock && this.sock.close(); } catch (_) {} }, 150);
    this.registered = false;
  }

  // ---------- helpers ----------
  // Account identity (From/Contact/AOR user) for SIP URIs: send the provisioned
  // username verbatim with ONLY spaces percent-encoded (%20), exactly like
  // eyeBeam. Keep "+", "(", ")", "-" literal. Do NOT strip to bare digits.
  _id(s) { return String(s || '').trim().replace(/ /g, '%20'); }
  // Dialed number (Request-URI/To user): drop formatting AND the leading "+"
  // (unless keepPlus) — trunk dial plans want bare digits like 18002908206.
  _num(s) {
    let v = String(s || '').replace(/[^\d+*#]/g, '');
    if (!this.keepPlus) v = v.replace(/^\+/, '');
    return v;
  }
  // Advertise the public mapping when STUN found one, else the local address.
  advIp() { return this.pubIp || this.localIp; }
  advPort() { return this.pubPort || this.localPort; }
  _via(branch) { return `SIP/2.0/UDP ${this.advIp()}:${this.advPort()};branch=z9hG4bK${branch};rport`; }
  _contact() { return `<sip:${this.user}@${this.advIp()}:${this.advPort()}>`; }
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
      `User-Agent: ${this.ua}`,
    ];
    if (auth) lines.push(auth);
    lines.push('Content-Length: 0', '', '');
    this._regBranch = branch; this._regExpires = expires;
    this._send(lines.join('\r\n'));
  }

  // ---------- INVITE (outbound call) ----------
  call(number) {
    const dest = this._num(number);
    if (!dest) return;
    this.hangup(); // one call at a time
    this.rtp = new RtpSession(this.localIp, (pcm) => this.emit('audio', pcm),
      { enabled: this.stunEnabled, host: this.stunHost, port: this.stunPort });
    this.rtp.open(() => {
      this.dialog = {
        number: dest, callId: rnd(10) + '@' + this.localIp, branch: rnd(8),
        cseq: this.cseq.INVITE++, toTag: null, state: 'calling',
        uri: `sip:${dest}@${this.cfg.domain}`,
      };
      this.callId = this.dialog.callId;
      this._sendInvite();
      this.emit('status', 'calling ' + dest + ' via ' + this.cfg.server + ':' + (this.cfg.port || 5060) + ' from ' + this.localIp + ':' + this.localPort);
      this._armInviteWatch();
    });
  }

  // No SIP reply to our INVITE means the trunk never heard us (UDP blocked, wrong
  // server/port) or we can't receive its reply (another softphone like eyeBeam is
  // holding UDP 5060, which this trunk replies to). Retransmit once, then fail
  // clearly instead of hanging on "Calling…" forever.
  _armInviteWatch() {
    this._clearCallWatch();
    this._inviteWatch = setTimeout(() => {
      const d = this.dialog; if (!d || d.state !== 'calling' || d._gotResp) return;
      if (!d._reinvited) {
        d._reinvited = true;
        this.emit('status', 'no reply yet — resending INVITE');
        this._sendInvite(d._lastAuth);
        this._inviteWatch = setTimeout(() => {
          const dd = this.dialog; if (!dd || dd.state !== 'calling' || dd._gotResp) return;
          this.emit('failed', 'no response from trunk (port ' + this.localPort + '). Close any other softphone (eyeBeam) so this phone can use UDP 5060, and check the trunk IP/port and firewall.');
          this._clearCallWatch();
          if (this.rtp) { this.rtp.close(); this.rtp = null; }
          this.dialog = null;
        }, 6000);
      }
    }, 6000);
  }
  // Trunk replied (so it's reachable) but never gave a final answer.
  _armAnswerWatch() {
    this._clearCallWatch();
    this._answerWatch = setTimeout(() => {
      const d = this.dialog; if (!d || (d.state !== 'calling' && d.state !== 'ringing')) return;
      this.emit('failed', 'no answer — trunk reachable but the call was not answered or routed');
      this._clearCallWatch();
      if (this.rtp) { this.rtp.close(); this.rtp = null; }
      this.dialog = null;
    }, 32000);
  }
  _clearCallWatch() {
    if (this._inviteWatch) { clearTimeout(this._inviteWatch); this._inviteWatch = null; }
    if (this._answerWatch) { clearTimeout(this._answerWatch); this._answerWatch = null; }
  }
  _sendInvite(auth) {
    const d = this.dialog; if (!d) return;
    // From identity keeps the "+" (account identity), unlike the dialed number.
    const fromUser = this.cfg.callerId ? this._id(this.cfg.callerId) : this.user;
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
      `Allow: INVITE, ACK, CANCEL, OPTIONS, BYE, REFER, NOTIFY, MESSAGE, SUBSCRIBE, INFO`,
      `Content-Type: application/sdp`,
      `User-Agent: ${this.ua}`,
    ];
    if (auth) lines.push(auth);
    lines.push(`Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp);
    const msg = lines.join('\r\n');
    this.emit('debug', '--- full INVITE ---\n' + lines.slice(0, lines.indexOf('') >= 0 ? lines.indexOf('') : lines.length).join('\n') + '\n--- (SDP omitted) ---');
    this._send(msg);
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
    this._clearCallWatch();
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
      // Honor the lifetime the trunk actually granted (Expires header, or the
      // Contact's expires= param) and refresh at ~80% of it, so the binding the
      // trunk needs to accept our calls never lapses between calls.
      let granted = 300;
      const eh = (msg.headers['expires'] || '').trim();
      if (/^\d+$/.test(eh)) granted = parseInt(eh, 10);
      else { const m = /expires=(\d+)/i.exec(msg.headers['contact'] || ''); if (m) granted = parseInt(m[1], 10); }
      if (!(granted > 0)) granted = 300;
      const refreshMs = Math.max(30, Math.floor(granted * 0.8)) * 1000;
      if (this.regTimer) clearInterval(this.regTimer);
      this.regTimer = setInterval(() => this.register(), refreshMs);
      this.emit('status', 'registered (expires ' + granted + 's, refresh ' + Math.round(refreshMs / 1000) + 's)');
      return;
    }
    if (msg.status >= 400) { this._clearRegWatch(); this.emit('registerFailed', msg.status + ' ' + (msg.reason || '')); }
  }

  _onInviteResp(msg, cseqH) {
    const d = this.dialog; if (!d) return;
    d._gotResp = true;                 // trunk is reachable — not a silent-drop case
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
      const auth = this._authHeader('INVITE', d.uri, ch, hdr);
      d._lastAuth = auth; d._reinvited = false; d._gotResp = false;
      this.emit('status', 'authenticating with trunk…');
      this._sendInvite(auth);
      this._armInviteWatch();          // wait for the authed INVITE's response
      return;
    }
    if (msg.status === 100) { this.emit('status', 'trunk reachable (100 Trying)…'); this._armAnswerWatch(); return; }
    if (msg.status === 180 || msg.status === 183) {
      if (d.state === 'calling') { d.state = 'ringing'; this.emit('ringing'); }
      this._armAnswerWatch();
      return;
    }
    if (msg.status >= 200 && msg.status < 300) {
      this._clearCallWatch();
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
      this._clearCallWatch();
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
  constructor(localIp, onPcm, stunOpts) {
    this.localIp = localIp; this.onPcm = onPcm;
    this.pubIp = null; this.pubPort = 0;
    this.stun = stunOpts || { enabled: false };
    this.sock = null; this.localPort = 0;
    this.remoteIp = null; this.remotePort = 0; this.payload = 0; // 0=PCMU 8=PCMA
    this.seq = Math.floor(Math.random() * 65535);
    this.ts = Math.floor(Math.random() * 2 ** 31);
    this.ssrc = Math.floor(Math.random() * 2 ** 31);
    this.txQueue = []; this.txTimer = null; this.muted = false;
    this._latched = false;
  }
  advIp() { return this.pubIp || this.localIp; }
  advPort() { return this.pubPort || this.localPort; }
  _attach(sock) {
    sock.on('message', (buf, rinfo) => {
      if (sock._stunCb && isStun(buf)) { sock._stunCb(buf); return; }
      this._recv(buf, rinfo);
    });
  }
  open(cb) {
    const finish = () => {
      this.localPort = this.sock.address().port;
      if (this.stun && this.stun.enabled) {
        stunDiscover(this.sock, this.stun.host, this.stun.port, (res) => {
          if (res && res.ip) { this.pubIp = res.ip; this.pubPort = res.port; }
          cb && cb();
        });
      } else { cb && cb(); }
    };
    this.sock = dgram.createSocket('udp4');
    this._attach(this.sock);
    this.sock.on('error', () => {});
    const tryBind = () => {
      const p = 10000 + (Math.floor(Math.random() * 10000) * 2 % 20000); // even-ish
      this.sock.bind(p, finish);
    };
    this.sock.once('error', () => { try { this.sock.close(); } catch (_) {} this.sock = dgram.createSocket('udp4'); this._attach(this.sock); this.sock.bind(finish); });
    tryBind();
  }
  offerSdp() {
    const sid = Math.floor(Math.random() * 1e9);
    return [
      'v=0',
      `o=- ${sid} ${sid} IN IP4 ${this.advIp()}`,
      's=-',
      `c=IN IP4 ${this.advIp()}`,
      't=0 0',
      `m=audio ${this.advPort()} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=sendrecv', '',
    ].join('\r\n');
  }
  setRemote(ip, port, payload) { this.remoteIp = ip; this.remotePort = port; this.payload = payload === 8 ? 8 : 0; this._latched = false; }
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
  _recv(buf, rinfo) {
    if (buf.length < 12) return;
    // Symmetric RTP (comedia): trunks behind their own NAT/SBC often send media
    // from an address different from the one in their SDP. Latch onto wherever
    // the audio actually comes from so return audio reaches them.
    if (rinfo && rinfo.address && (this.remoteIp !== rinfo.address || this.remotePort !== rinfo.port)) {
      this.remoteIp = rinfo.address; this.remotePort = rinfo.port; this._latched = true;
    }
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
