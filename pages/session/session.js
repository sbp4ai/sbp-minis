const app = getApp()
const sbp = app.globalData.sbp

const KEYS = [
  { k: 'ESC', t: 'Esc' }, { k: 'UP', t: '↑' }, { k: 'DOWN', t: '↓' },
  { k: '1', t: '1' }, { k: '2', t: '2' }, { k: '3', t: '3' },
  { k: 'y', t: 'y' }, { k: 'n', t: 'n' },
  { k: 'ENTER', t: 'Enter' }, { k: 'C-C', t: 'Ctrl-C' }
]

function hhmm(ts) {
  if (!ts) return ''
  var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts))
  if (isNaN(d.getTime())) return ''
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

Page({
  data: {
    sid: '',
    short: '',
    kindTerm: false,
    msgs: [],
    hasMore: false,
    nextBefore: null,
    loadingMore: false,
    scrollTop: 0,
    screenOpen: false,
    screenText: '',
    state: 'idle',
    stateText: '空闲',
    editable: false,
    prompt: null,
    draft: '',
    keys: KEYS
  },

  // ------------------------------------------------------------ 生命周期
  onLoad: function (opt) {
    var sid = decodeURIComponent(opt.sid || '')
    this.sid = sid
    this.short = sid.replace(/^term:/, '').slice(0, 8)
    this.kindTerm = sid.slice(0, 5) === 'term:'
    this.seen = {}
    this.setData({ sid: sid, short: this.short, kindTerm: this.kindTerm })
    wx.setNavigationBarTitle({ title: this.short })
  },

  onShow: function () {
    var that = this
    sbp.off('session.message'); sbp.off('output.delta'); sbp.off('session.state'); sbp.off('session.prompt')
    sbp.on('session.message', function (pl) {
      if (pl.sid !== that.sid) return
      that.pushMsg(pl.message)
    })
    sbp.on('output.delta', function (pl) {
      if (pl.sid !== that.sid) return
      that.setData({ screenText: (pl.lines || []).join('\n') })
    })
    sbp.on('session.state', function (pl) {
      if (pl.sid !== that.sid) return
      that.setData({ state: pl.status, stateText: that.mapState(pl.status) })
    })
    sbp.on('session.prompt', function (pl) {
      if (pl.sid !== that.sid) return
      that.onPrompt(pl)
    })

    if (sbp.state !== 'open') {
      var cfg = app.currentCfg()
      if (!cfg) { wx.showToast({ title: '先配置服务器', icon: 'none' }); return }
      sbp.connect(cfg).then(function () { that.boot() }).catch(function (e) {
        wx.showToast({ title: (e && e.msg) || '连不上', icon: 'none' })
      })
    } else {
      this.boot()
    }
  },

  onHide: function () {
    // 离开页面不再接收这个会话的事件；连接本身留给列表页
    sbp.off('session.message'); sbp.off('output.delta'); sbp.off('session.state'); sbp.off('session.prompt')
    if (this.sid) sbp.detach(this.sid)
  },
  onUnload: function () { this.onHide() },

  // ------------------------------------------------------------ 打开会话
  boot: function () {
    var that = this
    if (this._booted) return
    this._booted = true
    sbp.attach(this.sid).then(function (pl) {
      that.setData({
        editable: !!pl.editable,
        kindTerm: pl.kind === 'term',
        screenOpen: pl.kind === 'term',
        short: that.short
      })
      if (pl.prompt) that.onPrompt(pl.prompt)
      if (pl.kind === 'term') {
        // dsh / codex 这类没有 jsonl 的：不翻历史，直接看屏幕
        that.setData({ msgs: [], hasMore: false })
        return sbp.snapshot(that.sid, 60)
      }
      return that.loadLatest()
    }).then(function (pl) {
      if (pl && pl.lines) that.setData({ screenText: (pl.lines || []).join('\n') })
    }).catch(function (e) {
      wx.showToast({ title: (e && e.msg) || '打开会话失败', icon: 'none' })
    })
  },

  loadLatest: function () {
    var that = this
    return sbp.history(this.sid, null, 20).then(function (pl) {
      var items = (pl.items || []).map(that.fmt, that)
      that.setData({
        msgs: items,
        hasMore: !!pl.has_more,
        nextBefore: pl.next_before,
        scrollTop: 999990
      })
    }).catch(function (e) {
      if (e && e.code === 'E_NO_SESSION') {
        that.setData({ kindTerm: true, msgs: [], hasMore: false, screenOpen: true })
        return sbp.snapshot(that.sid, 60)
      }
      throw e
    })
  },

  fmt: function (m) {
    this.seen[m.seq] = 1
    return {
      seq: m.seq,
      role: m.role,
      kind: m.kind,
      time: hhmm(m.ts),
      text: clip(m.text, 1200)
    }
  },

  pushMsg: function (m) {
    if (!m || this.seen[m.seq]) return
    // scrollTop 给超范围值 = 贴底；末尾加一个自增尾巴，避免同值不触发滚动
    this._tick = (this._tick || 0) + 1
    this.setData({
      msgs: this.data.msgs.concat([this.fmt(m)]),
      scrollTop: 999990 + this._tick
    })
  },

  // ------------------------------------------------------------ 上滑翻页
  loadOlder: function () {
    var that = this
    if (this.data.loadingMore || !this.data.hasMore) return
    this.setData({ loadingMore: true })
    this.measure('.inner', function (h0) {
      sbp.history(that.sid, that.data.nextBefore, 20).then(function (pl) {
        var add = (pl.items || []).filter(function (m) { return !that.seen[m.seq] }).map(that.fmt, that)
        that.setData({
          msgs: add.concat(that.data.msgs),
          hasMore: !!pl.has_more,
          nextBefore: pl.next_before,
          loadingMore: false
        }, function () {
          // 视口锚定：新内容插在上方，scrollTop 补上增量，别把用户顶下去
          that.measure('.inner', function (h1) {
            var top = Math.round(h1 - h0)
            that.setData({ scrollTop: 0 })
            setTimeout(function () { that.setData({ scrollTop: top }) }, 40)
          })
        })
      }).catch(function (e) {
        that.setData({ loadingMore: false })
        wx.showToast({ title: (e && e.msg) || '加载失败', icon: 'none' })
      })
    })
  },

  measure: function (sel, cb) {
    wx.createSelectorQuery().in(this).select(sel).boundingClientRect(function (r) {
      cb(r ? r.height : 0)
    }).exec()
  },

  // ------------------------------------------------------------ SBP-0.2 选项卡片
  onPrompt: function (pl) {
    if (!pl || !pl.pid) return
    if (pl.state !== 'open') {
      if (this.data.prompt && this.data.prompt.pid === pl.pid) {
        this.setData({ prompt: null, state: 'running', stateText: '运行中' })
      }
      return
    }
    this.setData({
      prompt: pl,
      state: 'waiting',
      stateText: '等你选择',
      screenOpen: true
    })
  },

  dismissPrompt: function () {
    var p = this.data.prompt
    if (!p) return
    var that = this
    sbp.answer(this.sid, { pid: p.pid, dismiss: true }).then(function () {
      that.setData({ prompt: null, state: 'running', stateText: '运行中' })
    })
  },

  tapOption: function (e) {
    var p = this.data.prompt
    if (!p) return
    var i = +e.currentTarget.dataset.i
    var free = e.currentTarget.dataset.free === 1
    var that = this
    var go = function (text) {
      var payload = { pid: p.pid, choice: i }
      if (text) payload.text = text
      sbp.answer(that.sid, payload).then(function () {
        that.setData({ prompt: null, state: 'running', stateText: '运行中' })
      }).catch(function (err) {
        if (err && err.code === 'E_PROMPT_STALE') {
          that.setData({ prompt: null })
          wx.showToast({ title: '该选项已过期', icon: 'none' })
        } else {
          wx.showToast({ title: (err && err.msg) || '作答失败', icon: 'none' })
        }
      })
    }
    if (free) {
      wx.showModal({
        title: '选了这项，agent 会等你说明',
        editable: true,
        placeholderText: '例如：只删 dist，不动 node_modules',
        success: function (r) { if (r.confirm) go(r.content) }
      })
    } else {
      go('')
    }
  },

  // ------------------------------------------------------------ 输入
  onDraft: function (e) { this.setData({ draft: e.detail.value }) },

  send: function () {
    var t = (this.data.draft || '').trim()
    if (!t) return
    var that = this
    this.setData({ draft: '' })
    sbp.input(this.sid, t).then(function () {
      setTimeout(function () { that.setData({ scrollTop: 999999 }) }, 200)
    }).catch(function (e) {
      wx.showToast({ title: (e && e.msg) || '发送失败', icon: 'none' })
    })
  },

  sendKey: function (e) {
    var k = e.currentTarget.dataset.k
    var that = this
    sbp.key(this.sid, k).catch(function (e) {
      wx.showToast({ title: (e && e.msg) || '按键失败', icon: 'none' })
    })
  },

  toggleScreen: function () { this.setData({ screenOpen: !this.data.screenOpen }) },

  copy: function (e) {
    var m = this.data.msgs[+e.currentTarget.dataset.i]
    if (!m) return
    wx.setClipboardData({ data: m.text })
  },

  mapState: function (s) {
    if (s === 'waiting') return '等你选择'
    if (s === 'running') return '运行中'
    return '空闲'
  }
})
