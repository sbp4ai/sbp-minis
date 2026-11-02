const app = getApp()
const sbp = app.globalData.sbp

function ago(ms) {
  if (!ms) return ''
  var d = Math.floor((Date.now() - ms) / 1000)
  if (d < 60) return '刚刚'
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前'
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前'
  if (d < 2592000) return Math.floor(d / 86400) + ' 天前'
  var t = new Date(ms)
  return (t.getMonth() + 1) + '-' + t.getDate()
}

var AGENT_LABEL = {
  'claude-code': 'Claude', 'qwen-code': 'Qwen', 'qodercli': 'Qoder',
  codex: 'Codex', dsh: 'DSH', aider: 'Aider', opencode: 'OpenCode',
  hermes: 'Hermes', openclaw: 'OpenClaw', workbuddy: 'WorkBuddy'
}

/** 侧栏配色：按 agent 给每个会话一个稳定的标签字母与色号 */
function agentTag(agent, kind) {
  if (kind === 'shell') return { letter: '>_', cls: 'shell', name: '空终端' }
  var a = String(agent || '')
  var key = 'other'
  if (a.indexOf('claude') > -1) key = 'claude'
  else if (a.indexOf('codex') > -1) key = 'codex'
  else if (a.indexOf('dsh') > -1) key = 'dsh'
  else if (a.indexOf('qwen') > -1) key = 'qwen'
  else if (a.indexOf('hermes') > -1) key = 'hermes'
  return {
    letter: (AGENT_LABEL[a] || a || '?').slice(0, 1).toUpperCase(),
    cls: key,
    name: AGENT_LABEL[a] || a || (kind === 'term' ? '终端' : 'agent')
  }
}

Page({
  data: {
    cfg: null,
    state: 'closed',
    tip: '',
    groups: [],
    loading: false,
    err: '',
    serverNames: [],
    serverIdx: 0,
    total: 0
  },

  onLoad: function () {
    var that = this
    sbp.on('open', function () { that.setData({ state: 'open', tip: '已连接' }) })
    sbp.on('close', function () { that.setData({ state: 'closed', tip: '已断开，重连中…' }) })
    sbp.on('reconnect', function (ms) { that.setData({ tip: Math.round(ms / 1000) + 's 后重连' }) })
    sbp.on('giveup', function () { that.setData({ tip: '重连失败', err: '连不上服务器，检查地址/证书/合法域名' }) })
    sbp.on('heartbeat-timeout', function (silent) {
      that.setData({ tip: '心跳超时，重连中' })
      wx.showToast({ title: Math.round(silent / 1000) + 's 无响应，已重连', icon: 'none' })
    })
    sbp.on('auth-fail', function (e) {
      that.setData({ err: '认证失败：' + ((e && e.msg) || '签名不对') + '，去服务器页检查密钥' })
      sbp.close()
    })
    // 设备侧索引变化（agent 起了 / 退了）：列表跟着变，不用等下拉刷新
    sbp.on('sessions.index', function () { that.load() })
    sbp.on('session.index', function () { that.load() })
  },

  onShow: function () {
    var cfg = app.currentCfg()
    var names = app.servers().map(function (s) { return s.name || s.url || '未命名' })
    this.setData({
      cfg: cfg,
      serverNames: names,
      serverIdx: app.globalData.current || 0
    })
    if (!cfg) return
    if (sbp.state !== 'open') this.reload()
    else this.load()
  },

  /** 顶部下拉换机器：先断开旧连接，再用新配置重连 */
  onSwitch: function (e) {
    var idx = +e.detail.value
    if (idx === app.globalData.current) return
    app.useServer(idx)
    sbp.close()
    this.setData({ cfg: app.currentCfg(), serverIdx: idx, groups: [], err: '' })
    this.reload()
  },

  onPullDownRefresh: function () {
    var that = this
    this.load().then(function () { wx.stopPullDownRefresh() })
      .catch(function () { wx.stopPullDownRefresh() })
  },

  reload: function () {
    var that = this
    var cfg = app.currentCfg()
    if (!cfg) return Promise.resolve()
    this.setData({ loading: true, err: '' })
    return sbp.connect(cfg).then(function () {
      that.setData({ state: 'open' })
      return that.load()
    }).catch(function (e) {
      that.setData({
        loading: false, state: 'closed',
        err: '连不上：' + ((e && e.msg) || '检查 IP/端口/证书/合法域名')
      })
    })
  },

  // 只拉索引：sid + 标题 + 状态，一行正文都不带
  load: function () {
    var that = this
    this.setData({ loading: true })
    var cfg = app.currentCfg() || {}
    return sbp.list().then(function (pl) {
      var total = 0
      var secs = []
      var byKey = {}
      ;(pl.groups || []).forEach(function (g) {
        // 灰的历史会话不上列表：只留「此刻还在跑」的那些（空终端占位也算一条）
        var items = (g.items || []).filter(function (it) {
          return it.active === true || it.status === 'running'
        }).map(function (it) {
          var tag = agentTag(it.agent, it.kind)
          var title = it.title || it.short || it.sid.slice(0, 8)
          var tmux = it.tmux || g.name || ''
          return {
            sid: it.sid,
            short: it.short || it.sid.slice(0, 8),
            title: title,
            subtitle: it.subtitle || '',
            // 标题本身就是 tmux 名（空终端）时不再重复挂个 chip
            tmux: tmux === title ? '' : tmux,
            count: it.count || 0,
            kind: it.kind,
            agent: it.agent,
            shell: it.kind === 'shell',
            tag: tag,
            time: ago(it.updated_at)
          }
        })
        if (!items.length) return
        // 面板把每个 tmux 报成一个 group，中继按设备报（带 did）。
        // 这里统一成「一台机器一张卡」，卡里再按会话列，否则一屏全是重复的组头。
        var local = !g.did
        var key = local ? 'local' : ('did:' + g.did)
        var sec = byKey[key]
        if (!sec) {
          sec = byKey[key] = {
            key: key,
            name: local ? (cfg.name || '本机') : (g.name || '设备'),
            cwd: local ? '' : (g.cwd || ''),
            live: false,
            count: 0,
            open: true,
            items: []
          }
          secs.push(sec)
        }
        sec.live = sec.live || !!g.live
        sec.count += items.length
        sec.items = sec.items.concat(items)
        total += items.length
      })
      // 有 agent 在跑的机器排前面
      secs.sort(function (a, b) {
        if (a.live !== b.live) return a.live ? -1 : 1
        if (a.live) return 0
        return a.name > b.name ? 1 : -1
      })
      that.setData({ groups: secs, total: total, loading: false, err: '' })
    }).catch(function (e) {
      that.setData({ loading: false, err: (e && e.msg) || '列表加载失败' })
      throw e
    })
  },

  toggle: function (e) {
    var i = +e.currentTarget.dataset.i
    var k = 'groups[' + i + '].open'
    var o = {}
    o[k] = !this.data.groups[i].open
    this.setData(o)
  },

  open: function (e) {
    wx.navigateTo({ url: '/pages/session/session?sid=' + encodeURIComponent(e.currentTarget.dataset.sid) })
  }
})
