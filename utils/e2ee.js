// SBP-0.4 E2EE —— 微信小程序用的加密内核（tweetnacl，纯 JS，小程序运行时能跑）。
//
// 与控制台（libsodium-wrappers）和 Python（PyNaCl）的线格式逐字节一致：
//   envelope { v:"sbp/0.3e", tag, kid, eph, sig, cipher }
//   inner    { type:"req|res|evt", name, id/ref, sid?, payload }
//   scope    "dev|{did}" / "sid|{did}|{sid}"
//
// 为什么不用 libsodium：小程序里 WASM 版 libsodium 跑不起来，所以换成 tweetnacl
// （同一套 NaCl 原语：X25519 + XSalsa20-Poly1305 的 crypto_box、Ed25519 签名），
// 实测与 PyNaCl 的 crypto_box / libsodium 的 crypto_box_easy 字节兼容。
//
// HMAC 仍然自己实现（libsodium 的 crypto_auth 是 HMAC-SHA512/256，spec 要的是
// HMAC-SHA256），base64 也不用 atob/btoa —— 小程序里没有。
var nacl = require('./nacl.js')

// PRNG：小程序里拿不到 crypto，用 Math.random 兜底。nonce 只需要「不重复」，
// 不需要不可预测，所以这里够用；密钥本身由 sbp-agent 生成后导入，不在小程序里造。
try {
  nacl.setPRNG(function (x, len) {
    for (var i = 0; i < len; i++) x[i] = Math.floor(Math.random() * 256)
  })
} catch (e) {}

var VERSION = 'sbp/0.3e'
var NONCE_LEN = 24
var CHALLENGE_PREFIX = 'sbp1|'
var CONNECT_PREFIX = 'sbp1.'

// ----------------------------------------------------------------- base64url
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
var B64R = (function () {
  var m = {}
  for (var i = 0; i < B64.length; i++) m[B64.charAt(i)] = i
  m['-'] = 62; m['_'] = 63
  return m
})()

function b64u_encode(bytes) {
  var s = '', i, len = bytes.length
  for (i = 0; i + 2 < len; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  var rem = len - i
  if (rem === 1) {
    var n1 = bytes[i] << 16
    s += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + '=='
  } else if (rem === 2) {
    var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8)
    s += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '='
  }
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64u_decode(text) {
  var t = String(text).replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  var len = t.length
  var out = new Uint8Array(Math.floor(len * 3 / 4))
  var p = 0, buf = 0, bits = 0
  for (var i = 0; i < len; i++) {
    var c = t.charAt(i)
    if (c === '=') break
    var v = B64R[c]
    if (v === undefined) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) { bits -= 8; out[p++] = (buf >> bits) & 0xff }
  }
  return out.subarray(0, p)
}

function b64urlDecodeStr(s) {
  return bytesToUtf8(b64u_decode(s))
}

// ------------------------------------------------------------------ utf8
function utf8(str) {
  var out = []
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c >= 0xd800 && c <= 0xdbff) {
      var c2 = str.charCodeAt(++i)
      var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff)
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return new Uint8Array(out)
}

function bytesToUtf8(bytes) {
  var s = ''
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  try {
    // 小程序里 decodeURIComponent/escape 都在，只是没有 atob
    return decodeURIComponent(escape(s))
  } catch (e) {
    return s
  }
}

function concat() {
  var total = 0, i, a
  for (i = 0; i < arguments.length; i++) total += arguments[i].length
  var r = new Uint8Array(total), off = 0
  for (i = 0; i < arguments.length; i++) { a = arguments[i]; r.set(a, off); off += a.length }
  return r
}

// --------------------------------------------------------- 纯 JS SHA256/HMAC
var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]
function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }
function sha256(msg) {
  var l = msg.length
  var total = (Math.floor((l + 8) / 64) + 1) * 64
  var buf = new Uint8Array(total)
  buf.set(msg)
  buf[l] = 0x80
  var dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296))
  dv.setUint32(total - 4, (l * 8) >>> 0)
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  var w = new Int32Array(64)
  var off, j
  for (off = 0; off < total; off += 64) {
    for (j = 0; j < 16; j++) w[j] = dv.getInt32(off + j * 4, false)
    for (j = 16; j < 64; j++) {
      var w15 = w[j - 15], w2 = w[j - 2]
      var s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      var s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (j = 0; j < 64; j++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      var ch = (e & f) ^ (~e & g)
      var t1 = (h + S1 + ch + K[j] + w[j]) >>> 0
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      var maj = (a & b) ^ (a & c) ^ (b & c)
      var t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  var out = new Uint8Array(32)
  var odv = new DataView(out.buffer)
  for (var i2 = 0; i2 < 8; i2++) odv.setUint32(i2 * 4, H[i2] >>> 0)
  return out
}
function hmac_sha256(keyBytes, msgBytes) {
  var B = 64
  if (keyBytes.length > B) keyBytes = sha256(keyBytes)
  var ik = new Uint8Array(B), ok = new Uint8Array(B)
  var i
  for (i = 0; i < B; i++) { ik[i] = 0x36; ok[i] = 0x5c }
  for (i = 0; i < B; i++) {
    var k = keyBytes[i] || 0
    ik[i] ^= k; ok[i] ^= k
  }
  return sha256(concat(ok, sha256(concat(ik, msgBytes))))
}

// ------------------------------------------------------------- 密钥 / 派生
function generateKeypair() {
  var box = nacl.box.keyPair()
  var sign = nacl.sign.keyPair()
  return {
    box_sk: box.secretKey, box_pk: box.publicKey,
    sign_sk: sign.secretKey, sign_pk: sign.publicKey
  }
}

/** 只接受 64-hex 的 rk（.copy4client 里就是这种）—— 小程序里没有 Argon2id。 */
function deriveRk(material) {
  if (typeof material === 'string' && /^[0-9a-fA-F]{64}$/.test(material)) {
    var rk = new Uint8Array(32)
    for (var i = 0; i < 32; i++) rk[i] = parseInt(material.substr(i * 2, 2), 16)
    return rk
  }
  throw new Error('小程序只支持 64-hex 的路由密钥 rk（.copy4client 导出的就是这种）')
}

// ------------------------------------------------------------- 路由盲化
function computeTag(rk, scope) {
  return b64u_encode(hmac_sha256(rk, utf8(scope)))
}

// ------------------------------------------------------------- 握手挑战
function signChallenge(sign_sk, keyId, ts, nonce) {
  return b64u_encode(nacl.sign.detached(utf8(CHALLENGE_PREFIX + keyId + '|' + ts + '|' + nonce), sign_sk))
}
function verifyChallenge(sign_pk, keyId, ts, nonce, sig_b64) {
  try {
    return nacl.sign.detached.verify(
      utf8(CHALLENGE_PREFIX + keyId + '|' + ts + '|' + nonce), b64u_decode(sig_b64), sign_pk)
  } catch (e) { return false }
}

// ------------------------------------------------------------- 信封
function _signedMessage(tag, eph_pk, cipher) {
  return concat(utf8(tag), eph_pk, cipher)
}
function wrap(inner, rk, sender_sign_sk, recipient_box_pk, scope) {
  var eph = nacl.box.keyPair()
  var nonce = nacl.randomBytes(NONCE_LEN)
  var ct = nacl.box(utf8(JSON.stringify(inner)), nonce, recipient_box_pk, eph.secretKey)
  var cipher = concat(nonce, ct)
  var tag = computeTag(rk, scope)
  return {
    v: VERSION, tag: tag, kid: null,
    eph: b64u_encode(eph.publicKey),
    sig: b64u_encode(nacl.sign.detached(_signedMessage(tag, eph.publicKey, cipher), sender_sign_sk)),
    cipher: b64u_encode(cipher)
  }
}
function unwrap(envelope, rk, receiver_box_sk, peer_sign_pk) {
  var eph = b64u_decode(envelope.eph)
  var cipher = b64u_decode(envelope.cipher)
  if (peer_sign_pk) {
    var ok = false
    try {
      ok = nacl.sign.detached.verify(
        _signedMessage(envelope.tag, eph, cipher), b64u_decode(envelope.sig), peer_sign_pk)
    } catch (e) { ok = false }
    if (!ok) throw new Error('bad frame signature')
  }
  var plain = nacl.box.open(cipher.subarray(NONCE_LEN), cipher.subarray(0, NONCE_LEN), eph, receiver_box_sk)
  if (!plain) throw new Error('decrypt failed')
  return JSON.parse(bytesToUtf8(plain))
}

// -------------------------------------------------- 连接串（.copy4client）
function decodeConnect(line) {
  var raw = String(line).trim()
  if (raw.indexOf(CONNECT_PREFIX) !== 0) throw new Error('不是 sbp1. 连接串')
  var p = JSON.parse(b64urlDecodeStr(raw.slice(CONNECT_PREFIX.length)))
  return {
    v: p.v || '', name: p.name || p.myKeyId || 'SBP', url: p.url || '',
    auth: 'e2ee', keyId: '', secret: '', cred: '', transport: 'ws',
    e2ee: true, did: p.did || '', myKeyId: p.myKeyId || 'cli', rk: p.rk || '',
    peerKeyId: p.peerKeyId || 'dev', peerBoxPk: p.peerBoxPk || '', peerSignPk: p.peerSignPk || '',
    box_sk: p.box_sk || '', sign_sk: p.sign_sk || '',
    box_pk: p.box_pk || '', sign_pk: p.sign_pk || ''
  }
}
function parseConnectText(text) {
  var out = []
  String(text || '').split(/\r?\n/).forEach(function (line) {
    line = line.trim()
    if (!line || line.indexOf(CONNECT_PREFIX) !== 0) return
    try { out.push(decodeConnect(line)) } catch (e) {}
  })
  return out
}

/** cfg（粘贴导入进来的连接串）-> E2EELink。私钥只存在小程序的 storage 里。 */
function makeLink(cfg) {
  if (!cfg || !cfg.box_sk || !cfg.sign_sk) throw new Error('E2EE 配置缺少私钥，请用 .copy4client 导入')
  if (!cfg.rk) throw new Error('E2EE 配置缺少路由密钥 rk')
  if (!cfg.peerBoxPk || !cfg.peerSignPk) throw new Error('E2EE 配置缺少设备公钥')
  return new E2EELink({
    kp: { box_sk: b64u_decode(cfg.box_sk), sign_sk: b64u_decode(cfg.sign_sk) },
    peerBoxPk: b64u_decode(cfg.peerBoxPk),
    peerSignPk: b64u_decode(cfg.peerSignPk),
    rk: deriveRk(cfg.rk),
    keyId: cfg.myKeyId || 'cli',
    did: cfg.did,
    role: 'client'
  })
}

// ------------------------------------------------------------- 端点链路
function E2EELink(opts) {
  this.kp = opts.kp
  this.peerBoxPk = opts.peerBoxPk
  this.peerSignPk = opts.peerSignPk
  this.peerKeyId = opts.peerKeyId || 'dev'
  this.rk = opts.rk
  this.kid = opts.keyId || 'cli'
  this.did = opts.did || opts.keyId || 'dev'
  this.role = opts.role || 'client'
}
E2EELink.prototype.deviceScope = function () { return 'dev|' + this.did }
E2EELink.prototype.sessionScope = function (sid) { return 'sid|' + this.did + '|' + sid }
E2EELink.prototype.hello = function () {
  var ts = Date.now()
  var nonce = Math.random().toString(36).slice(2) + ts.toString(36)
  return {
    v: VERSION, id: 'h1', type: 'req', name: 'hello',
    payload: {
      role: this.role, keyId: this.kid, ts: ts, nonce: nonce,
      sig: signChallenge(this.kp.sign_sk, this.kid, ts, nonce), did: this.did
    }
  }
}
E2EELink.prototype._ctl = function (op, scope) {
  var tag = computeTag(this.rk, scope)
  return {
    v: VERSION, ctl: op, tag: tag, kid: this.kid,
    sig: b64u_encode(nacl.sign.detached(utf8(tag), this.kp.sign_sk))
  }
}
E2EELink.prototype.subscribe = function (scope) { return this._ctl('sub', scope) }
E2EELink.prototype.unsubscribe = function (scope) { return this._ctl('unsub', scope) }
E2EELink.prototype.send = function (inner, scope) {
  var env = wrap(inner, this.rk, this.kp.sign_sk, this.peerBoxPk, scope)
  env.kid = this.kid
  return env
}
E2EELink.prototype.recv = function (envelope) {
  if (envelope.ctl) return envelope
  return unwrap(envelope, this.rk, this.kp.box_sk, this.peerSignPk)
}

module.exports = {
  VERSION: VERSION, NONCE_LEN: NONCE_LEN, CONNECT_PREFIX: CONNECT_PREFIX,
  nacl: nacl,
  b64u_encode: b64u_encode, b64u_decode: b64u_decode, b64urlDecodeStr: b64urlDecodeStr,
  utf8: utf8, bytesToUtf8: bytesToUtf8,
  sha256: sha256, hmac_sha256: hmac_sha256,
  generateKeypair: generateKeypair, deriveRk: deriveRk,
  computeTag: computeTag, signChallenge: signChallenge, verifyChallenge: verifyChallenge,
  wrap: wrap, unwrap: unwrap,
  decodeConnect: decodeConnect, parseConnectText: parseConnectText,
  makeLink: makeLink, E2EELink: E2EELink
}
