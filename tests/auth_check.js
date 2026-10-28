/**
 * 公私钥（HMAC）握手的开/关验证。
 *
 * 前置：panel 用 SBP_HMAC_KEYS=keyId:secret 启动
 *   SBP_HMAC_KEYS=mac-mini-01:demo-secret-123 python -m tmux_panel --port 20017
 *
 * 用法：
 *   cd app/minis
 *   NODE_PATH=<ws 库路径> node tests/auth_check.js ws://127.0.0.1:20017/ws
 *
 * 期望：不带签名 → 被服务端踢掉；带正确签名 → 放行；签名错 → 也被踢掉。
 */
const WebSocket = require('ws')

const base = process.argv[2] || 'ws://127.0.0.1:20017/ws'
const KEY_ID = 'mac-mini-01'
const SECRET = 'demo-secret-123'

function hexHmac(key, msg) {
  const crypto = require('crypto')
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(msg, 'utf8')).digest('hex')
}

/** three 种握手：无签名 / 正确签名 / 错误签名 */
function handshake(auth) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base)
    const done = (r) => { try { ws.close() } catch (e) {} resolve(r) }
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; done({ ok: false, why: 'timeout' }) } }, 5000)

    ws.on('open', () => {
      let payload = { role: 'client' }
      if (auth === 'good' || auth === 'bad') {
        const ts = Date.now()
        const nonce = Math.random().toString(36).slice(2)
        const sig = hexHmac(auth === 'good' ? SECRET : SECRET + 'x',
                            `sbp1\n${KEY_ID}\n${ts}\n${nonce}`)
        payload.auth = { scheme: 'hmac-sha256', keyId: KEY_ID, ts, nonce, sig }
      }
      ws.send(JSON.stringify({ v: 'sbp/0.1', id: 'h1', type: 'req', name: 'hello', payload }))
    })
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.name === 'hello') {
        clearTimeout(timer)
        if (!settled) { settled = true; done({ ok: !!f.ok, err: f.err, payload: f.payload }) }
      }
    })
    ws.on('close', (code) => {
      clearTimeout(timer)
      if (!settled) { settled = true; done({ ok: false, why: 'closed ' + code }) }
    })
    ws.on('error', () => {})
  })
}

let pass = 0, fail = 0
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name) }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  ' + extra : '')) }
}

;(async () => {
  console.log('\n[1] 不签名')
  const a = await handshake('none')
  ck('被拒绝', !a.ok, JSON.stringify(a.err || a.why))
  if (a.err) ck('错误码 E_AUTH', a.err.code === 'E_AUTH', a.err.code)

  console.log('\n[2] 正确签名')
  const b = await handshake('good')
  ck('放行', b.ok, JSON.stringify(b.err || b.why))
  ck('服务端回报要求签名', b.ok && !!((b.payload || {}).server || {}).sbp_auth,
     JSON.stringify((b.payload || {}).server))

  console.log('\n[3] 错误签名（篡改密钥）')
  const c = await handshake('bad')
  ck('被拒绝', !c.ok, JSON.stringify(c.err || c.why))

  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
})()
