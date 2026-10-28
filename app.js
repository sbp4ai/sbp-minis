const sbp = require('./utils/sbp.js')

const KEY_SERVERS = 'sbp_servers'
const KEY_CURRENT = 'sbp_current'

App({
  globalData: {
    sbp: sbp,
    servers: [],
    current: null      // 当前服务器在 servers 里的下标
  },

  onLaunch: function () {
    var list = wx.getStorageSync(KEY_SERVERS) || []
    this.globalData.servers = list
    var idx = wx.getStorageSync(KEY_CURRENT)
    if (typeof idx === 'number' && list[idx]) this.globalData.current = idx
    else this.globalData.current = list.length ? 0 : null
  },

  servers: function () { return this.globalData.servers },

  currentCfg: function () {
    var i = this.globalData.current
    var s = this.globalData.servers
    return (i !== null && s[i]) ? s[i] : null
  },

  saveServer: function (cfg, idx) {
    var list = this.globalData.servers.slice()
    if (typeof idx === 'number' && list[idx]) list[idx] = cfg
    else list.push(cfg)
    this.globalData.servers = list
    wx.setStorageSync(KEY_SERVERS, list)
    return list.length - 1
  },

  removeServer: function (idx) {
    var list = this.globalData.servers.slice()
    list.splice(idx, 1)
    this.globalData.servers = list
    wx.setStorageSync(KEY_SERVERS, list)
    if (this.globalData.current === idx) this.globalData.current = list.length ? 0 : null
  },

  useServer: function (idx) {
    this.globalData.current = idx
    wx.setStorageSync(KEY_CURRENT, idx)
  }
})
