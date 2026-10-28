// 纯 JS HMAC-SHA256 —— 小程序里没有 WebCrypto，签名只能自己算。
//
// 用途：SBP 握手的密钥证明。小程序只发签名，不发密钥本身：
//   sig = HMAC-SHA256(secret, "sbp1\n" + keyId + "\n" + ts + "\n" + nonce)
// 服务端存的是同一个 secret，自己算一遍比对即可。
// 小程序算不了 Ed25519 这类非对称签名，所以这里用对称密钥 ——
// 「公钥」在配置里就是用来标识用哪把钥匙的 keyId，不参与运算。

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

function utf8(s) {
  var out = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return new Uint8Array(out)
}

function sha256(msg) {
  var l = msg.length
  var total = (Math.floor((l + 8) / 64) + 1) * 64
  var buf = new Uint8Array(total)
  buf.set(msg)
  buf[l] = 0x80
  var dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, Math.floor(l * 8 / 4294967296))
  dv.setUint32(total - 4, (l * 8) >>> 0)

  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  var w = new Int32Array(64)

  for (var off = 0; off < total; off += 64) {
    var j
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
  for (var i = 0; i < 8; i++) odv.setUint32(i * 4, H[i])
  return out
}

function cat(a, b) {
  var r = new Uint8Array(a.length + b.length)
  r.set(a, 0); r.set(b, a.length)
  return r
}

function hex(bytes) {
  var s = ''
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i].toString(16)
    s += v.length < 2 ? '0' + v : v
  }
  return s
}

function hmac(keyBytes, msgBytes) {
  var B = 64
  if (keyBytes.length > B) keyBytes = sha256(keyBytes)
  var ik = new Uint8Array(B), ok = new Uint8Array(B)
  for (var i = 0; i < B; i++) { ik[i] = 0x36; ok[i] = 0x5c }
  for (i = 0; i < B; i++) {
    var k = keyBytes[i] || 0
    ik[i] ^= k
    ok[i] ^= k
  }
  return sha256(cat(ok, sha256(cat(ik, msgBytes))))
}

/** HMAC-SHA256 十六进制串 */
function hmacHex(secretStr, msgStr) {
  return hex(hmac(utf8(secretStr), utf8(msgStr)))
}

/** SBP 握手签名：keyId / ts / nonce 都进签名，防止重放 */
function sign(secretStr, keyId, ts, nonce) {
  return hmacHex(secretStr, 'sbp1\n' + keyId + '\n' + ts + '\n' + nonce)
}

module.exports = { hmacHex: hmacHex, sign: sign, sha256Hex: function (s) { return hex(sha256(utf8(s))) } }
