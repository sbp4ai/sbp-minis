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

Page({
  data: {
    cfg: null,
    state: 'closed',
    tip: '',
    groups: [],
    loading: false,
    err: '',
    serverNames: [],
    serverIdx: 0
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
    return sbp.list().then(function (pl) {
      var groups = (pl.groups || []).map(function (g, i) {
        return {
          key: g.kind + ':' + g.name,
          name: g.name,
          kind: g.kind,
          cwd: g.cwd,
          live: g.live,
          count: g.count,
          open: i === 0 || g.kind === 'term',
          items: (g.items || []).map(function (it) {
            return {
              sid: it.sid,
              short: it.short || it.sid.slice(0, 8),
              subtitle: it.subtitle || '',
              count: it.count,
              kind: it.kind,
              agent: it.agent,
              active: !!it.active,
              ago: ago(it.updated_at)
            }
          })
        }
      })
      that.setData({ groups: groups, loading: false, err: '' })
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
