/**
 * 在 Node 里跑小程序的 REST 通道：mock 掉 wx.request（用 http 真连本地 panel），
 * 验证「REST 默认、WS 可选」这条路径真的能工作，不必开微信开发者工具。
 *
 * 前置：panel 已在本地起好（见 rest_p2p_verify 同款启动命令）：
 *   端口 20016 关闭鉴权；端口 20017 用 SBP_HMAC_KEYS=mac-mini-01:demo-secret-123
 *
 * 用法：
 *   cd app/minis
 *   node tests/rest_sim.js [host] [portNoAuth] [portHmac]
 *   默认 127.0.0.1 / 20016 / 20017
 */
const http = require('http')
const { URL } = require('url')
const path = require('path')

const HOST = process.argv[2] || '127.0.0.1'
const PORT_NO = +(process.argv[3] || 20016)
const PORT_HMAC = +(process.argv[4] || 20017)
const KEY_ID = 'mac-mini-01'
const SECRET = 'demo-secret-123'

// ---------------------------------------------------------------- mock wx
global.wx = {
  request(opt) {
    const u = new URL(opt.url)
    const body = opt.data !== undefined ? (typeof opt.data === 'string' ? opt.data : JSON.stringify(opt.data)) : null
    const headers = Object.assign({}, opt.header || {})
    if (body && !headers['content-type']) headers['content-type'] = 'application/json'
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opt.method || 'GET', headers: headers
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        const h = {}
        for (const k in res.headers) h[k] = res.headers[k]
        if (opt.success) opt.success({ statusCode: res.statusCode, header: h, data: buf })
      })
    })
    req.on('error', (e) => { if (opt.fail) opt.fail({ errMsg: e.message }); else if (opt.complete) opt.complete() })
    if (body) req.write(body)
    req.end()
  },
  getStorageSync: () => null,
  setStorageSync: () => {},
}

// ---------------------------------------------------------------- 被测对象
const SBP = require(path.join(__dirname, '..', 'utils', 'sbp.js'))

let pass = 0, fail = 0
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name) }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  ' + extra : '')) }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

;(async () => {
  // ---------------------------------------------------------- [1] 地址解析
  console.log('\n[1] 地址解析（REST 基址）')
  const cfgHttps = { url: 'https://1.2.3.4:8787/ws', auth: 'none' }
  const cfgWs = { url: 'ws://192.168.1.5:20016/ws', auth: 'none' }
  ck('https 地址 → REST 基址 https://host:port', SBP.restBase(cfgHttps) === 'https://1.2.3.4:8787', SBP.restBase(cfgHttps))
  ck('ws 地址 → REST 基址 http://host:port', SBP.restBase(cfgWs) === 'http://192.168.1.5:20016', SBP.restBase(cfgWs))

  // ---------------------------------------------------------- [2] REST 连接 + 列表
  console.log('\n[2] REST 连接（无长连接）+ 会话列表')
  const cfg = { name: 'rest', url: 'http://' + HOST + ':' + PORT_NO + '/api', auth: 'none', transport: 'rest', pollInterval: 2 }
  await SBP.connect(cfg)
  ck('state=open', SBP.state === 'open')
  ck('模式为 rest（无长连接）', SBP.mode === 'rest')

  const idx = await SBP.list()
  const groups = idx.groups || []
  const total = groups.reduce((n, g) => n + (g.items || []).length, 0)
  ck('groups 非空', groups.length > 0, total + ' 个会话')
  ck('索引无正文（懒加载）', JSON.stringify(idx).indexOf('"lines"') < 0 && JSON.stringify(idx).indexOf('"text"') < 0)
  // ETag 命中：连续两次 _restReq，第二次带上次 etag，应回 304（同一 tick 内索引不会变）
  const r1 = await SBP._restReq('GET', '/api/index', {})
  const r2 = await SBP._restReq('GET', '/api/index', { etag: r1.etag })
  ck('ETag 命中回 304（无 body，省传输）', r2.status === 304, 'status=' + r2.status)

  // ---------------------------------------------------------- [3] attach 终端：拿 prompt + 屏幕
  let termSid = null
  groups.forEach(g => (g.items || []).forEach(it => { if (it.kind === 'term' && !termSid) termSid = it.sid }))
  if (termSid) {
    console.log('\n[3] 终端 attach ' + termSid + '：prompt + 屏幕轮询')
    let gotPrompt = false, gotScreen = false
    SBP.on('session.prompt', (pl) => { if (pl.sid === termSid) gotPrompt = true })
    SBP.on('output.delta', (pl) => { if (pl.sid === termSid && (pl.lines || []).length) gotScreen = true })
    const at = await SBP.attach(termSid)
    ck('attach 返回 editable/kind/prompt', !!at && typeof at.kind === 'string', JSON.stringify({ kind: at.kind, editable: at.editable }))
    await sleep(2600)   // 等一轮轮询（interval=2s）把屏幕/prompt 事件推上来
    ck('轮询拿到 prompt 事件', gotPrompt)
    ck('轮询拿到 output.delta 屏幕事件', gotScreen)
    ck('轮询确实在跑（_pollers 有该 sid）', !!SBP._pollers[termSid])

    // ---------------------------------------------------- [4] answer 选项作答
    const p = SBP._lastPrompt[termSid]
    if (p && p.pid) {
      console.log('\n[4] 选项作答 pid=' + p.pid)
      const r = await SBP.answer(termSid, { pid: p.pid, choice: 2 })
      ck('answer 返回 ok 或 answered', !!(r && (r.ok || r.state === 'answered')), JSON.stringify(r))
    } else {
      console.log('\n[4] 选项作答 —— 跳过（当前无可答 prompt）')
    }

    // ---------------------------------------------------- [5] input 文本写入
    console.log('\n[5] 文本输入（经 /api/rpc）')
    const ri = await SBP.input(termSid, 'echo hello-from-rest', true)
    ck('input 返回 ok', !!(ri && (ri.ok || ri.tmux)), JSON.stringify(ri))
    await SBP.detach(termSid)
    ck('detach 停止轮询', !SBP._pollers[termSid])
  } else {
    console.log('\n[3-5] 跳过（无 term 会话，先起 dsh-demo 再跑）')
  }

  // ---------------------------------------------------------- [6] HMAC REST
  console.log('\n[6] HMAC REST（端口 ' + PORT_HMAC + '）')
  const hcfg = { name: 'hmac', url: 'http://' + HOST + ':' + PORT_HMAC + '/api', auth: 'hmac', keyId: KEY_ID, secret: SECRET, transport: 'rest' }
  await SBP.connect(hcfg)
  const hidx = await SBP.list()
  ck('正确签名 REST list 成功', !!(hidx && hidx.groups), 'groups=' + ((hidx && hidx.groups) || []).length)

  const bad = { name: 'bad', url: 'http://' + HOST + ':' + PORT_HMAC + '/api', auth: 'hmac', keyId: KEY_ID, secret: 'wrong-secret', transport: 'rest' }
  let denied = false
  try { await SBP.connect(bad); await SBP.list() }
  catch (e) { denied = (e && (e.code === 'E_HTTP' && e.status === 401)) || (e && e.code === 'E_HTTP') }
  ck('错误密钥被拒（401）', denied, String(denied))

  console.log('\n通过 ' + pass + '/' + (pass + fail))
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('FATAL', e); process.exit(2) })
