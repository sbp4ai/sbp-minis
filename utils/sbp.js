// SBP v0.1 / v0.2 客户端 —— 微信小程序版
//
// 帧格式与 spec/SBP-0.1.md 一致：
//   {"v":"sbp/0.1","id":..,"type":"req|res|evt","name":..,"sid":..,"payload":{}}
// 交互提示部分见 spec/SBP-0.2-interaction.md（session.prompt / session.answer）。
//
// 传输层有两条：
//   rest（默认）—— 定时 HTTP 轮询，GET 带 ETag（没变回 304 不带 body），写操作走 POST /api/rpc。
//                  不保持长连接，最省服务端资源，断网/网关拦 WS 都能用。
//   ws（可选）  —— 长连接，服务端主动推；在配置里把 transport 显式设成 "ws" 才开，连不上再降级。
//
// 两种传输对外的语义封装（list/attach/history/input/answer/key/snapshot）完全一致，
// 页面代码不感知差别；差别只在「这一帧是走 REST 还是走 WS」。

var V = 'sbp/0.1'
var hmac = require('./hmac.js')

/**
 * 地址只留一个输入框：scheme://host:port/path 全都能从这一串里拆出来。
 * 不写 scheme 默认 wss（公网要求），不写端口按 scheme 补 443/80，不写路径用 /ws。
 */
function parseUrl(raw) {
  var s = String(raw || '').trim()
  // ws:// 与 http:// 都当作「非加密」；wss:// 与 https:// 当作加密。
  var wss = !/^ws:\/\//i.test(s) && !/^http:\/\//i.test(s)
  s = s.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  var slash = s.indexOf('/')
  var hostport = slash > -1 ? s.slice(0, slash) : s
  var path = slash > -1 ? s.slice(slash) : '/ws'
  var host = hostport
  var port = wss ? 443 : 80
  var m = hostport.match(/^\[(.+)\]:(\d+)$/)       // [IPv6]:port
  if (m) { host = m[1]; port = +m[2] }
  else {
    var m2 = hostport.match(/^([^:]+):(\d+)$/)     // host:port
    if (m2) { host = m2[1]; port = +m2[2] }
  }
  if (!path) path = '/ws'
  return { wss: wss, host: host, port: port, path: path }
}

/** REST 用的 http(s) 基址：与 WS 同端口，只是换 scheme。 */
function restBase(cfg) {
  var p = parseUrl(cfg.url || (cfg.host ? cfg.host + ':' + (cfg.port || 443) + (cfg.path || '/ws') : ''))
  var scheme = p.wss ? 'https' : 'http'
  return scheme + '://' + (p.host.indexOf(':') > -1 ? '[' + p.host + ']' : p.host) + ':' + p.port
}

function SBP() {
  this.ws = null
  this.seq = 0
  this.pending = {}
  this.listeners = {}
  this.state = 'closed'
  this.cfg = null
  this.mode = 'rest'          // 'rest' | 'ws'，由 cfg.transport 决定，默认 rest
  this.retry = 0
  this.timer = null
  this.hbTimer = null
  this.hbN = 0
  this.lastRecv = 0
  this.wantClose = false
  this.server = {}            // hello 回包里的 server 信息
  this.caps = []
  // ---- REST 轮询态 ----
  this._base = ''
  this._pollers = {}          // sid -> setInterval id
  this._etagIndex = null
  this._lastIndex = null
  this._etagState = {}        // sid -> etag
  this._lastState = {}        // sid -> 上次 body
  this._lastScreen = {}       // sid -> 上次屏幕文本
  this._lastPrompt = {}       // sid -> {pid, state}
  this._seenSeq = {}          // sid -> {seq:1}
}

SBP.prototype.on = function (name, fn) {
  ;(this.listeners[name] = this.listeners[name] || []).push(fn)
  return this
}

SBP.prototype.off = function (name) {
  delete this.listeners[name]
  return this
}

SBP.prototype.emit = function (name, payload, frame) {
  ;(this.listeners[name] || []).forEach(function (f) { f(payload, frame) })
  ;(this.listeners['*'] || []).forEach(function (f) { f(name, payload, frame) })
}

// ------------------------------------------------------------------ url
SBP.prototype.url = function (cfg) {
  var p = parseUrl(cfg.url || (cfg.host ? cfg.host + ':' + (cfg.port || 443) + (cfg.path || '/ws') : ''))
  var url = (p.wss ? 'wss' : 'ws') + '://' + (p.host.indexOf(':') > -1 ? '[' + p.host + ']' : p.host) +
            ':' + p.port + (p.path.charAt(0) === '/' ? p.path : '/' + p.path)
  if (cfg.auth === 'token' && cfg.cred) {
    url += (p.path.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(cfg.cred)
  }
  return url
}

// ------------------------------------------------------------------ connect
SBP.prototype.connect = function (cfg) {
  var that = this
  this.cfg = cfg
  this.wantClose = false
  this.mode = (cfg && cfg.transport === 'ws') ? 'ws' : 'rest'
  this._base = restBase(cfg)
  if (this.mode === 'ws') return this._wsConnect(cfg)
  // ---- REST 模式：不建长连接，直接当作「已就绪」，每个请求独立打服务端 ----
  return new Promise(function (resolve) {
    that.state = 'open'
    that.retry = 0
    that.server = { v: V, transport: 'rest' }
    that.emit('open')
    resolve(true)
  })
}

// =================================================================== WS 通道
SBP.prototype._wsConnect = function (cfg) {
  var that = this
  this.wantClose = false
  return new Promise(function (resolve, reject) {
    if (that.ws) { try { that.ws.close() } catch (e) {} }
    var header = { 'content-type': 'application/json' }
    if (cfg.auth === 'cookie' && cfg.cred) header['Cookie'] = cfg.cred
    if (cfg.auth === 'token' && cfg.cred) header['X-SBP-Token'] = cfg.cred
    if (cfg.auth === 'bearer' && cfg.cred) header['Authorization'] = 'Bearer ' + cfg.cred

    var settled = false
    var task = wx.connectSocket({
      url: that.url(cfg),
      header: header,
      fail: function (e) {
        if (!settled) { settled = true; reject(e && e.errMsg ? { code: 'E_CONNECT', msg: e.errMsg } : { code: 'E_CONNECT', msg: '连接失败' }) }
      }
    })
    that.ws = task

    task.onOpen(function () {
      that.state = 'open'
      that.retry = 0
      that.lastRecv = Date.now()
      that.emit('open')
      settled = true
      resolve(true)
      // 握手：拿服务端能力与版本。sbp-server 要求 token 在这一帧里
      var hp = { role: 'client' }
      if (cfg.auth === 'token' && cfg.cred) hp.token = cfg.cred
      if (cfg.auth === 'hmac' && cfg.secret) {
        var ts = Date.now()
        var nonce = Math.random().toString(36).slice(2) + ts.toString(36)
        hp.auth = {
          scheme: 'hmac-sha256',
          keyId: cfg.keyId || 'default',
          ts: ts,
          nonce: nonce,
          sig: hmac.sign(cfg.secret, cfg.keyId || 'default', ts, nonce)
        }
      }
      that._wsReq('hello', hp, null, 6000).then(function (pl) {
        that.server = pl.server || {}
        that.caps = pl.caps || []
      }).catch(function (e) {
        // 服务端要求签名而这里没配 —— 直接踢掉，别留一条假在线的线
        if (e && e.code === 'E_AUTH') that.emit('auth-fail', e)
      })
      that.startHeartbeat()
    })

    task.onMessage(function (res) { that._wsOnMessage(res.data) })

    task.onClose(function () {
      that.state = 'closed'
      that.stopHeartbeat()
      that.emit('close')
      if (!settled) { settled = true; reject({ code: 'E_CONNECT', msg: '连接被关闭' }) }
      that.scheduleReconnect()
    })

    task.onError(function (e) {
      that.emit('error', e)
      if (!settled) { settled = true; reject({ code: 'E_CONNECT', msg: (e && e.errMsg) || '连接错误' }) }
    })
  })
}

SBP.prototype.scheduleReconnect = function () {
  var that = this
  if (this.wantClose || !this.cfg || this.mode !== 'ws') return
  if (this.retry >= 6) { this.emit('giveup'); return }
  var delay = Math.min(8000, Math.round(700 * Math.pow(1.6, this.retry++)))
  clearTimeout(this.timer)
  this.emit('reconnect', delay)
  this.timer = setTimeout(function () {
    that._wsConnect(that.cfg).catch(function () {})
  }, delay)
}

SBP.prototype.close = function () {
  this.wantClose = true
  clearTimeout(this.timer)
  this.stopHeartbeat()
  this.state = 'closed'
  var that = this
  Object.keys(this._pollers).forEach(function (k) { that._stopPoller(k) })
  try { this.ws && this.ws.close() } catch (e) {}
  this.emit('close')
}

// ------------------------------------------------------------------ 心跳
// 应用层心跳：小程序拿不到 WS 层的 ping，只能自己发 ping 帧。
// 间隔是每个包的间隔，超时是「多久没收到任何帧」就判定线路已死。
SBP.prototype.startHeartbeat = function () {
  var that = this
  this.stopHeartbeat()
  var iv = Math.max(5, (this.cfg && +this.cfg.hbInterval) || 20) * 1000
  var to = Math.max(iv * 3, ((this.cfg && +this.cfg.hbTimeout) || 60) * 1000)
  this.hbTimer = setInterval(function () {
    if (that.state !== 'open' || !that.ws) return
    var silent = Date.now() - that.lastRecv
    if (silent > to) {
      // 判定线路已死：主动关掉，交给 onClose 里的重连
      that.emit('heartbeat-timeout', silent)
      try { that.ws.close() } catch (e) {}
      return
    }
    that.hbN++
    that.ws.send({
      data: JSON.stringify({
        v: V, id: 'hb' + that.hbN, type: 'req', name: 'ping',
        payload: { t: Date.now(), rtt: silent }
      })
    })
  }, iv)
}

SBP.prototype.stopHeartbeat = function () {
  if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null }
}

// ------------------------------------------------------------------ WS 帧
SBP.prototype._wsReq = function (name, payload, sid, timeout) {
  var that = this
  timeout = timeout || 10000
  return new Promise(function (resolve, reject) {
    if (that.state !== 'open' || !that.ws) {
      reject({ code: 'E_OFFLINE', msg: '未连接服务器' })
      return
    }
    var id = 'm' + (++that.seq)
    var frame = { v: V, id: id, type: 'req', name: name, payload: payload || {} }
    if (sid) frame.sid = sid
    that.pending[id] = {
      resolve: resolve,
      reject: reject,
      t: setTimeout(function () {
        delete that.pending[id]
        reject({ code: 'E_TIMEOUT', msg: '请求超时：' + name })
      }, timeout)
    }
    that.ws.send({ data: JSON.stringify(frame) })
  })
}

SBP.prototype._wsOnMessage = function (data) {
  var f
  this.lastRecv = Date.now()
  try { f = JSON.parse(data) } catch (e) { return }
  if (!f || !f.type) return
  if (f.type === 'res') {
    var p = this.pending[f.ref]
    if (p) {
      clearTimeout(p.t)
      delete this.pending[f.ref]
      if (f.ok) p.resolve(f.payload || {})
      else p.reject(f.err || { code: 'E_UNKNOWN', msg: '请求失败' })
    }
    return
  }
  if (f.type === 'evt') this.emit(f.name, f.payload || {}, f)
}

// =================================================================== REST 通道
// 通用 HTTP 助手：GET/POST 都用 wx.request，自动带 ETag / HMAC 签名。
SBP.prototype._restReq = function (method, path, opts) {
  opts = opts || {}
  var that = this
  var cfg = this.cfg || {}
  return new Promise(function (resolve, reject) {
    var url = that._base + path
    var q = []
    if (opts.query) opts.query.forEach(function (kv) { q.push(encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1])) })
    if (cfg.auth === 'hmac' && cfg.secret) {
      var ts = Date.now()
      var nonce = Math.random().toString(36).slice(2) + ts.toString(36)
      var sig = hmac.sign(cfg.secret, cfg.keyId || 'default', ts, nonce)
      q.push('keyId=' + encodeURIComponent(cfg.keyId || 'default'))
      q.push('ts=' + ts)
      q.push('nonce=' + encodeURIComponent(nonce))
      q.push('sig=' + encodeURIComponent(sig))
    } else if (cfg.auth === 'token' && cfg.cred) {
      q.push('token=' + encodeURIComponent(cfg.cred))
    }
    if (q.length) url += (path.indexOf('?') > -1 ? '&' : '?') + q.join('&')

    var header = { 'content-type': 'application/json' }
    if (cfg.auth === 'cookie' && cfg.cred) header['Cookie'] = cfg.cred
    if (cfg.auth === 'bearer' && cfg.cred) header['Authorization'] = 'Bearer ' + cfg.cred
    if (opts.etag) header['If-None-Match'] = opts.etag

    wx.request({
      url: url,
      method: method,
      header: header,
      data: opts.body ? JSON.stringify(opts.body) : undefined,
      success: function (res) {
        var h = res.header || {}
        var etag = h['ETag'] || h['etag']
        if (res.statusCode === 304) {
          resolve({ status: 304, etag: etag, body: opts.lastBody })
          return
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          var body = res.data
          if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) {} }
          resolve({ status: res.statusCode, etag: etag, body: body })
        } else {
          reject({ code: 'E_HTTP', msg: 'HTTP ' + res.statusCode, status: res.statusCode, body: res.data })
        }
      },
      fail: function (e) { reject({ code: 'E_HTTP', msg: (e && e.errMsg) || '请求失败' }) }
    })
  })
}

// 写操作：一个 SBP 帧装进 POST /api/rpc，res 解析给调用方，evt 直接 emit（让页面像 WS 一样收到）。
SBP.prototype._restRpc = function (frame) {
  var that = this
  if (frame.type !== 'req') frame.type = 'req'
  if (!frame.id) frame.id = 'm' + (++that.seq)
  return new Promise(function (resolve, reject) {
    that._restReq('POST', '/api/rpc', { body: { frames: [frame] } }).then(function (r) {
      var out = (r.body && r.body.frames) || []
      var res = null, resOk = null, err = null
      out.forEach(function (f) {
        if (f.type === 'evt') that.emit(f.name, f.payload || {}, f)
        else if (f.type === 'res') { res = f.payload || {}; resOk = f.ok; if (!f.ok) err = f.err || { code: 'E_UNKNOWN', msg: '请求失败' } }
      })
      if (resOk === true) resolve(res)
      else if (resOk === false) reject(err || { code: 'E_UNKNOWN', msg: '请求失败' })
      else resolve(res || {})
    }).catch(reject)
  })
}

SBP.prototype._restState = function (sid, interval) {
  var that = this
  var path = '/api/state?sid=' + encodeURIComponent(sid) + '&interval=' + encodeURIComponent(interval || 5)
  var etag = this._etagState[sid]
  return this._restReq('GET', path, { etag: etag, lastBody: this._lastState[sid] }).then(function (r) {
    if (r.status === 304) return that._lastState[sid] || { sid: sid, lines: [], prompt: null }
    that._etagState[sid] = r.etag
    that._lastState[sid] = r.body
    return r.body
  })
}

SBP.prototype._restHistory = function (sid, before, limit) {
  var path = '/api/history?sid=' + encodeURIComponent(sid) +
             '&before=' + encodeURIComponent(before || '') +
             '&limit=' + encodeURIComponent(limit || 20)
  return this._restReq('GET', path, {}).then(function (r) { return r.body })
}

// ---- REST 轮询：屏幕/prompt 变化 → 模拟 WS 的 output.delta / session.prompt 事件 ----
SBP.prototype._startPoller = function (sid, interval) {
  var that = this
  this._stopPoller(sid)
  var iv = Math.max(2000, (interval || 5) * 1000)
  var isTerm = sid.slice(0, 5) === 'term:'
  var timer = setInterval(function () {
    if (that.wantClose || that.mode !== 'rest') { that._stopPoller(sid); return }
    that._restState(sid, interval).then(function (st) {
      var cur = (st.lines || []).join('\n')
      if (that._lastScreen[sid] === undefined || that._lastScreen[sid] !== cur) {
        that._lastScreen[sid] = cur
        that.emit('output.delta', { sid: sid, mode: 'screen', lines: st.lines || [] })
      }
      that._handlePrompt(sid, st.prompt)
      if (!isTerm) {
        // claude 会话：轮询历史拿到新消息，模拟 session.message 推送
        that._restHistory(sid, null, 20).then(function (h) {
          that._emitNewMessages(sid, (h && h.items) || [])
        }).catch(function () {})
      }
    }).catch(function (e) { that.emit('error', e) })
  }, iv)
  this._pollers[sid] = timer
}

SBP.prototype._stopPoller = function (sid) {
  if (this._pollers[sid]) { clearInterval(this._pollers[sid]); delete this._pollers[sid] }
}

SBP.prototype._handlePrompt = function (sid, prompt) {
  var last = this._lastPrompt[sid] || {}
  if (prompt && prompt.pid) {
    if (!last.pid || last.pid !== prompt.pid || (last.state === 'answered' && prompt.state !== 'answered')) {
      this._lastPrompt[sid] = { pid: prompt.pid, state: prompt.state || 'open' }
      this.emit('session.prompt', Object.assign({ sid: sid }, prompt))
    }
  } else if (!prompt && last.pid && last.state === 'open') {
    // 作答后服务端把 prompt 置空：发一个 answered 事件让卡片收起
    this._lastPrompt[sid] = { pid: last.pid, state: 'answered' }
    this.emit('session.prompt', { sid: sid, pid: last.pid, state: 'answered' })
  }
}

SBP.prototype._emitNewMessages = function (sid, items) {
  var seen = this._seenSeq[sid] || {}
  var that = this
  items.forEach(function (m) {
    if (m && m.seq && !seen[m.seq]) {
      seen[m.seq] = 1
      that.emit('session.message', { sid: sid, message: m })
    }
  })
  this._seenSeq[sid] = seen
}

// ------------------------------------------------------------------ 语义封装
// 懒加载的关键：先只要列表（sid+标题），点进去才拉正文
SBP.prototype.list = function () {
  if (this.mode === 'ws') return this._wsReq('session.list', {}, null)
  var that = this
  return this._restReq('GET', '/api/index', { etag: this._etagIndex, lastBody: this._lastIndex }).then(function (r) {
    if (r.status === 304) return that._lastIndex || { ok: true, groups: [] }
    that._etagIndex = r.etag
    that._lastIndex = r.body
    return r.body
  })
}

SBP.prototype.history = function (sid, before, limit) {
  if (this.mode === 'ws') return this._wsReq('session.history', { sid: sid, before: before || null, limit: limit || 20 }, sid)
  return this._restHistory(sid, before, limit)
}

SBP.prototype.attach = function (sid) {
  if (this.mode === 'ws') return this._wsReq('session.attach', { sid: sid }, sid)
  var that = this
  var interval = (this.cfg && +this.cfg.pollInterval) || 5
  return this._restState(sid, interval).then(function (st) {
    that._startPoller(sid, interval)
    return { sid: sid, last_seq: st.last_seq, tmux: st.tmux,
             editable: !!st.tmux, kind: st.tmux ? 'term' : 'claude', prompt: st.prompt }
  })
}

SBP.prototype.detach = function (sid) {
  if (this.mode === 'ws') return this._wsReq('session.detach', { sid: sid }, sid).catch(function () {})
  this._stopPoller(sid)
  return this._restRpc({ type: 'req', name: 'session.detach', payload: {}, sid: sid }).catch(function () { return {} })
}

SBP.prototype.input = function (sid, text, submit) {
  if (this.mode === 'ws') return this._wsReq('session.input', { kind: 'text', text: text, submit: submit !== false }, sid)
  return this._restRpc({ type: 'req', name: 'session.input', payload: { kind: 'text', text: text, submit: submit !== false }, sid: sid })
}

SBP.prototype.key = function (sid, k) {
  if (this.mode === 'ws') return this._wsReq('session.input', { kind: 'key', key: k }, sid)
  return this._restRpc({ type: 'req', name: 'session.input', payload: { kind: 'key', key: k }, sid: sid })
}

SBP.prototype.snapshot = function (sid, lines) {
  if (this.mode === 'ws') return this._wsReq('pane.snapshot', { sid: sid, lines: lines || 60 }, sid)
  return this._restState(sid, 5).then(function (st) {
    return { sid: sid, tmux: st.tmux, lines: st.lines || [], prompt: st.prompt }
  })
}

// SBP-0.2：选项作答
SBP.prototype.answer = function (sid, payload) {
  if (this.mode === 'ws') return this._wsReq('session.answer', payload, sid)
  return this._restRpc({ type: 'req', name: 'session.answer', payload: payload, sid: sid })
}

// req 是底层通用口：WS 走 _wsReq，REST 走 _restRpc（settings 的「测试连接」就用它）
SBP.prototype.req = function (name, payload, sid, timeout) {
  if (this.mode === 'ws') return this._wsReq(name, payload, sid, timeout)
  return this._restRpc({ type: 'req', name: name, payload: payload || {}, sid: sid || null })
}

// 地址解析挂在原型上，方便页面/测试直接 sbp.url() / sbp.restBase() 调用
SBP.prototype.parseUrl = parseUrl
SBP.prototype.restBase = restBase

module.exports = new SBP()
