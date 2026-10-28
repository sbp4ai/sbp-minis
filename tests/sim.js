/**
 * 在 Node 里跑小程序代码：mock 掉 wx.*，真连一次服务端。
 *
 * 目的：minis/utils/sbp.js 是纯 JS，但依赖 wx.connectSocket。这里用 ws 库替身，
 * 于是地址解析、握手签名、心跳、懒加载、选项作答这些逻辑都能在 CI 里验证，
 * 不必开微信开发者工具。
 *
 * 用法：
 *   cd app/minis
 *   NODE_PATH=<node workspace>/node_modules node tests/sim.js ws://127.0.0.1:20016/ws [keyId] [secret]
 */
const WebSocket = require('ws')
const path = require('path')

const [url, keyId, secret] = process.argv.slice(2)

// ---------------------------------------------------------------- mock wx
function WxTask(ws) {
  const t = {}
  t.onOpen = (f) => { ws.on('open', () => f({})) }
  t.onMessage = (f) => { ws.on('message', (d) => f({ data: d.toString() })) }
  t.onClose = (f) => { ws.on('close', () => f({})) }
  t.onError = (f) => { ws.on('error', (e) => f({ errMsg: e.message })) }
  t.send = (o) => ws.send(o.data)
  t.close = () => ws.close()
  return t
}
global.wx = {
  connectSocket(opt) {
    const ws = new WebSocket(opt.url, { headers: opt.header || {} })
    const task = WxTask(ws)
    // wx 的 fail 在连接建立失败时触发
    ws.on('error', () => { if (opt.fail) opt.fail({ errMsg: 'connect fail' }) })
    ws.on('unexpected-response', () => ws.close())
    return task
  },
  getStorageSync: () => null,
  setStorageSync: () => {},
  // 心跳定时器：小程序与 Node 都是 setInterval / clearInterval
}

// ---------------------------------------------------------------- 被测对象
const SBP = require(path.join(__dirname, '..', 'utils', 'sbp.js'))

let pass = 0, fail = 0
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name) }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  ' + extra : '')) }
}

const cfg = {
  name: 'sim',
  url: url || 'ws://127.0.0.1:20016/ws',
  auth: keyId && secret ? 'hmac' : 'none',
  keyId: keyId || '',
  secret: secret || '',
  transport: 'ws',
  hbInterval: 5,
  hbTimeout: 15,
  autoReconnect: false
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

;(async () => {
  console.log('\n[1] 地址解析')
  console.log('      ' + SBP.url(cfg))
  ck('url 里带 scheme/host/port/path', /^(wss?):\/\/[^:]+:\d+\/.*$/.test(SBP.url(cfg)), SBP.url(cfg))

  console.log('\n[2] 连接 + 握手')
  await SBP.connect(cfg)
  await sleep(900)
  ck('state=open', SBP.state === 'open')
  ck('拿到 server 信息', !!(SBP.server && SBP.server.v), JSON.stringify(SBP.server))
  ck('caps 含 ping', SBP.caps.indexOf('ping') > -1, String(SBP.caps.length))

  console.log('\n[3] 心跳（间隔 5s，等 12s 看是否还活着）')
  await sleep(12000)
  const res = await SBP.req('ping', { t: Date.now() })
  ck('ping 有响应', res && res.ts > 0, JSON.stringify(res))
  const pings = SBP.hbN
  ck('心跳已自动发出', pings >= 2, pings + ' 个')

  console.log('\n[4] 会话列表（只拉索引）')
  const idx = await SBP.list()
  const groups = idx.groups || []
  const total = groups.reduce((n, g) => n + (g.items || []).length, 0)
  ck('groups 非空', groups.length > 0, total + ' 个会话')
  const blob = JSON.stringify(idx)
  ck('索引无正文', blob.indexOf('"text"') < 0, Math.ceil(blob.length / 1024) + 'KB')

  let termSid = null, sample = null
  groups.forEach(g => (g.items || []).forEach(it => {
    if (it.kind === 'term' && !termSid) termSid = it.sid
    if (it.kind !== 'term' && !sample) sample = it
  }))

  if (sample) {
    console.log('\n[5] claude 会话 ' + sample.short + ' 的懒加载')
    const at = await SBP.attach(sample.sid)
    ck('attach ok', !!at, JSON.stringify(Object.keys(at || {})))
    const p1 = await SBP.history(sample.sid, null, 20)
    ck('首屏有内容', (p1.items || []).length > 0, (p1.items || []).length + ' 条')
    if (p1.has_more && p1.next_before) {
      const p2 = await SBP.history(sample.sid, p1.next_before, 20)
      const a = p1.items[0].seq, b = p2.items[p2.items.length - 1].seq
      ck('翻页更早', b < a, b + ' < ' + a)
    }
    await SBP.detach(sample.sid)
  }

  if (termSid) {
    console.log('\n[6] 终端会话 ' + termSid + '：选项卡片')
    const at = await SBP.attach(termSid)
    const p = at.prompt
    ck('attach 就带 prompt', !!p)
    if (p) {
      console.log('      ' + p.kind + ' / ' + p.risk + ' / ' + p.title)
      console.log('      ' + JSON.stringify(p.options.map(o => [o.index, o.label])))
      let answered = true
      try { await SBP.answer(termSid, { pid: p.pid, choice: 1 }) }
      catch (e) { answered = false; console.log('      err=' + JSON.stringify(e)) }
      ck('点第 1 项作答成功', answered)
      await sleep(300)
      let stale = null
      try { await SBP.answer(termSid, { pid: p.pid, choice: 1 }) }
      catch (e) { stale = e.code }
      ck('过期 pid → E_PROMPT_STALE', stale === 'E_PROMPT_STALE', String(stale))
    }
    await SBP.detach(termSid)
  }

  SBP.close()
  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('崩了：', e); process.exit(1) })
