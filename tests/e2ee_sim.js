/**
 * 在 Node 里跑小程序 E2EE 链路：mock wx.connectSocket，真连一次 sbp-dispatcher 的 /ws-e2ee。
 *
 * 配置直接来自 sbp-agent 生成的 .copy4client（模拟小程序「粘贴导入」），
 * 走的是 utils/e2ee.js（tweetnacl）+ utils/sbp.js 的真实代码路径。
 *
 * 用法：
 *   cd sbp-minis
 *   NODE_PATH=<node_modules> node tests/e2ee_sim.js /path/to/.copy4client [ws://127.0.0.1:8799/ws-e2ee]
 */
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const copyFile = process.argv[2] || '/tmp/e2ee_run/.copy4client'
const overrideUrl = process.argv[3] || ''

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
    ws.on('error', () => { if (opt.fail) opt.fail({ errMsg: 'connect fail' }) })
    return task
  },
  getStorageSync: () => null,
  setStorageSync: () => {}
}

const e2ee = require(path.join(__dirname, '..', 'utils', 'e2ee.js'))
const SBP = require(path.join(__dirname, '..', 'utils', 'sbp.js'))

let pass = 0, fail = 0
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name) }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  ' + extra : '')) }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

;(async () => {
  console.log('\n[1] 粘贴导入：解析 .copy4client')
  const cfgs = e2ee.parseConnectText(fs.readFileSync(copyFile, 'utf8'))
  ck('解析出连接串', cfgs.length >= 1, cfgs.length + ' 条')
  const cfg = cfgs.filter(c => c.myKeyId === 'cli-minis')[0] || cfgs[0]
  if (overrideUrl) cfg.url = overrideUrl
  ck('带 e2ee 标记', cfg.e2ee === true)
  ck('带私钥（box_sk/sign_sk）', !!(cfg.box_sk && cfg.sign_sk))

  console.log('\n[2] 地址改写：E2EE 落到 /ws-e2ee')
  console.log('      ' + SBP.url(cfg))
  ck('路径以 /ws-e2ee 结尾', /\/ws-e2ee$/.test(SBP.url(cfg)), SBP.url(cfg))

  console.log('\n[3] 连接 + 签名握手')
  await SBP.connect(cfg)
  await sleep(900)
  ck('state=open', SBP.state === 'open')
  ck('链路已建立（link）', !!SBP.link)

  console.log('\n[4] 会话列表（密文往返）')
  const idx = await SBP.list()
  const groups = idx.groups || []
  const total = groups.reduce((n, g) => n + (g.items || []).length, 0)
  ck('groups 非空', groups.length > 0, total + ' 个会话')

  console.log('\n[5] 会话级 tag：attach + 抓屏')
  let sid = null
  groups.forEach(g => (g.items || []).forEach(it => { if (!sid && it.sid) sid = it.sid }))
  if (sid) {
    const at = await SBP.attach(sid)
    ck('attach ok', !!at, JSON.stringify(Object.keys(at || {})))
    const snap = await SBP.snapshot(sid, 40)
    ck('snapshot 有行', Array.isArray(snap.lines), (snap.lines || []).length + ' 行')
    await SBP.detach(sid)
  }

  SBP.close()
  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('崩了：', e); process.exit(1) })
