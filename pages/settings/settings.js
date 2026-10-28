const app = getApp()
const sbp = app.globalData.sbp

const AUTH = [
  { t: '无', v: 'none' },
  { t: 'Token', v: 'token' },
  { t: 'Cookie', v: 'cookie' },
  { t: 'Bearer', v: 'bearer' },
  { t: '公私钥 HMAC', v: 'hmac' }
]
function authIdx(v) {
  for (var i = 0; i < AUTH.length; i++) if (AUTH[i].v === v) return i
  return 0
}

const TRANS = [
  { t: 'REST 轮询（默认·省服务端）', v: 'rest' },
  { t: 'WebSocket 长连接（最低延迟）', v: 'ws' }
]
function transIdx(v) {
  for (var i = 0; i < TRANS.length; i++) if (TRANS[i].v === v) return i
  return 0
}

function blank() {
  return {
    id: 's' + Date.now(),
    name: '',
    url: 'https://',
    auth: 0,
    cred: '',
    keyId: '',
    secret: '',
    transport: 0,
    pollInterval: 5,
    hbInterval: 20,
    hbTimeout: 60,
    autoReconnect: true
  }
}

/** 老配置（host/port/path 分开存）自动并成一条 url */
function migrate(cfg) {
  if (cfg.url) return cfg
  var c = Object.assign({}, cfg)
  var scheme = c.wss === false ? 'ws' : 'wss'
  var port = c.port || (scheme === 'wss' ? 443 : 80)
  if ((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80)) port = ''
  c.url = scheme + '://' + (c.host || '') + (port ? ':' + port : '') + (c.path || '/ws')
  delete c.host; delete c.port; delete c.path; delete c.wss
  return c
}

Page({
  data: {
    list: [],
    currentIdx: null,
    editing: false,
    editIdx: null,
    form: blank(),
    authNames: AUTH,
    transNames: TRANS,
    parsed: '',
    testing: false,
    testMsg: ''
  },

  onShow: function () {
    var list = app.servers().map(function (c) {
      var m = migrate(c)
      m.authIdx = authIdx(m.auth)
      m.transIdx = transIdx(m.transport || 'rest')
      return m
    })
    this.setData({
      list: list,
      currentIdx: app.globalData.current,
      parsed: '',
      testMsg: ''
    })
  },

  // ------------------------------------------------------------ 表单
  onInput: function (e) {
    var k = e.currentTarget.dataset.k
    var f = {}
    f['form.' + k] = e.detail.value
    if (k === 'url') f.parsed = this.describe(e.detail.value)
    this.setData(f)
  },
  onAuth: function (e) { this.setData({ 'form.auth': +e.detail.value }) },
  onTrans: function (e) { this.setData({ 'form.transport': +e.detail.value }) },
  onAuto: function (e) { this.setData({ 'form.autoReconnect': e.detail.value }) },

  describe: function (raw) {
    if (!raw || raw === 'https://') return ''
    var u = sbp.url({ url: raw, auth: 'none' })
    var rb = sbp.restBase({ url: raw })
    return 'WS ' + u + ' ／ REST ' + rb + '（缺省部分已自动补全）'
  },

  // ------------------------------------------------------------ 列表
  add: function () {
    this.setData({ editing: true, editIdx: null, form: blank(), parsed: '', testMsg: '' })
  },
  edit: function (e) {
    var i = +e.currentTarget.dataset.i
    var cfg = migrate(JSON.parse(JSON.stringify(app.servers()[i])))
    this.setData({
      editing: true, editIdx: i, form: cfg, testMsg: '',
      'form.auth': authIdx(cfg.auth),
      parsed: this.describe(cfg.url)
    })
  },
  cancel: function () { this.setData({ editing: false, editIdx: null }) },
  del: function (e) {
    var i = +e.currentTarget.dataset.i
    var that = this
    wx.showModal({
      title: '删除服务器', content: (app.servers()[i] || {}).name || '未命名',
      success: function (r) {
        if (!r.confirm) return
        app.removeServer(i)
        that.onShow()
      }
    })
  },
  use: function (e) {
    var i = +e.currentTarget.dataset.i
    app.useServer(i)
    this.setData({ currentIdx: i })
    wx.showToast({ title: '已切换', icon: 'none' })
  },

  // ------------------------------------------------------------ 保存/测试
  normalize: function (form) {
    var cfg = JSON.parse(JSON.stringify(form))
    cfg.auth = AUTH[form.auth].v
    cfg.transport = TRANS[form.transport].v
    cfg.pollInterval = Math.max(2, parseInt(form.pollInterval, 10) || 5)
    cfg.hbInterval = Math.max(5, parseInt(form.hbInterval, 10) || 20)
    // 超时必须大于间隔的 3 倍，否则每次心跳都被判成超时
    cfg.hbTimeout = Math.max(cfg.hbInterval * 3, parseInt(form.hbTimeout, 10) || 60)
    if (cfg.auth !== 'hmac') { cfg.keyId = ''; cfg.secret = '' }
    if (cfg.auth === 'none') cfg.cred = ''
    return cfg
  },

  test: function () {
    var that = this
    var cfg = this.normalize(this.data.form)
    if (!cfg.url || cfg.url === 'https://') { wx.showToast({ title: '先填服务器地址', icon: 'none' }); return }
    var modeTxt = cfg.transport === 'ws' ? 'WS 长连接' : 'REST 轮询 ' + cfg.pollInterval + 's'
    this.setData({ testing: true, testMsg: '正在连接（' + modeTxt + '）' + sbp.url(cfg) + ' …' })
    sbp.connect(cfg).then(function () {
      if (cfg.transport === 'ws') return new Promise(function (r) { setTimeout(r, 700) })   // 等握手回包
      return null
    }).then(function () {
      return sbp.req('session.list', {}, null, 6000)
    }).then(function (pl) {
      var n = 0
      ;(pl.groups || []).forEach(function (g) { n += (g.items || []).length })
      that.setData({
        testing: false,
        testMsg: '✓ 已连接 · 传输 ' + modeTxt +
                 ' · 会话 ' + n + ' 个' + (cfg.transport === 'ws' ? ' · 心跳 ' + cfg.hbInterval + '/' + cfg.hbTimeout + 's' : '')
      })
      sbp.close()
    }).catch(function (err) {
      that.setData({ testing: false, testMsg: '✗ ' + ((err && err.msg) || '连接失败') })
      sbp.close()
    })
  },

  save: function () {
    var cfg = this.normalize(this.data.form)
    if (!cfg.url || cfg.url === 'wss://') { wx.showToast({ title: '先填服务器地址', icon: 'none' }); return }
    var idx = (this.data.editIdx === null) ? null : +this.data.editIdx
    var pos = app.saveServer(cfg, idx)
    app.useServer(idx === null ? pos : idx)
    this.setData({ editing: false, editIdx: null })
    this.onShow()
    wx.showToast({ title: '已保存' })
    wx.switchTab({ url: '/pages/index/index' })
  }
})
