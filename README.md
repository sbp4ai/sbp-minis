# sbp-minis · SBP 远程会话控制小程序

手机上看电脑上的 agent 会话：列表是 tmux 分组下的一条条会话，点进去才拉最新 20 条，
上滑继续翻更早；agent 把「1/2/3」选项摆到终端上时，这里是一排可以点的按钮。

协议走 [SBP v0.1](https://github.com/sbp4ai/sbp-spec/blob/main/spec/SBP-0.1.md) +
[交互提示扩展 v0.2](https://github.com/sbp4ai/sbp-spec/blob/main/spec/SBP-0.2-interaction.md)，
后端可以是 `sbp-server`，也可以是 `sbp-agent` 里的 `panel`（tmux-claude-panel），两端帧名这套小程序都对得上。

> 本仓库即仓库根（不再嵌套在 `app/minis/` 下），目录树请以仓库实际结构为准。

## 目录

```
app/minis/
├── app.js / app.json / app.wxss     全局（服务器配置持久化、全局协议单例）
├── utils/sbp.js                     协议客户端：地址解析、REST 轮询 + WS 长连接双通道、心跳、自动重连
├── utils/hmac.js                    纯 JS HMAC-SHA256（小程序没 WebCrypto，签名自己算）
├── pages/settings/                  地址、认证、传输方式、心跳 → 一键测连
├── pages/index/                     会话列表（只拉索引，不带正文）
├── pages/session/                   消息流 + 实时屏幕 + 选项卡片 + 输入
└── tests/                           在 Node 里 mock 掉 wx.* 跑真连接，不用开开发者工具
```

## 配置页四件事

### 1. 服务器地址（一个框搞定）

```
wss://sbp.example.com/ws     → wss + 443 + /ws
ws://192.168.1.9:20016/ws    → ws + 20016 + /ws
1.2.3.4:8787                 → 默认 wss + 8787 + /ws
```

scheme 不写默认 `wss`，端口不写按 scheme 补 443/80，路径不写补 `/ws`。

### 1.1 传输方式（新）

配置页「传输方式」二选一，**默认 REST 轮询**：

- **REST 轮询（默认）**：定时 `GET /api/index` + `/api/state` + `/api/history`，都带 `ETag`
  （没变回 304 不带 body），写操作走 `POST /api/rpc`。**不保持长连接，最省服务端资源**，
  WS 进后台被杀的尴尬也没有。轮询间隔在「轮询间隔」里设（默认 5 秒）。
- **WebSocket 长连接**：显式选才会开。只有明确要最低延迟时才切；连不上也自动降级回 REST。

两种传输对页面完全透明，`utils/sbp.js` 对外暴露的 `list/attach/history/input/answer/key`
语义一致，差别只在「这一帧走 REST 还是走 WS」。

### 2. 认证

| 方式 | 填什么 | 服务端 |
|---|---|---|
| 无 | — | `--no-auth` 的 panel |
| Token | 服务端签发的 token | sbp-server 设备绑定 |
| Cookie | `panel_session=xxx` | panel 登录后的 cookie |
| Bearer | JWT | 自建网关 |
| **公私钥 HMAC** | 公钥 KeyId + 私钥 Secret | panel 的 `.env` 里 `SBP_HMAC_KEYS=kid:secret` |

HMAC 的签名内容：`HMAC-SHA256(secret, "sbp1\n{keyId}\n{ts}\n{nonce}")`，
密钥本身从不上网，只发 ts/nonce/sig，服务端重算比对；ts 偏差超过 5 分钟即拒（防重放）。

为什么不是 Ed25519：小程序没有非对称签名的原生能力，强行移植会拖慢启动。
这里用对称密钥，「公钥」在配置里就是用来标识用哪把钥匙的 KeyId。

服务端侧（panel）在 `.env` 里写：

```bash
SBP_HMAC_KEYS=mac-mini-01:一把长随机串,macbook-pro:另一把串
```

配了就**必须**带签名才能连；不配就按原来的 cookie / `--no-auth` 逻辑走。

### 3. 心跳（间隔 / 超时）

> 仅 WebSocket 模式生效；REST 轮询没有长连接，不需要心跳。

小程序拿不到 WS 层的 ping，只能用应用层心跳：每 `间隔` 秒发一个 `ping` 帧，
若 `超时` 秒内一个字节都没收到，判定线路已死 → 主动关掉 → 走重连。

- 间隔默认 20s，超时默认 60s（代码里强制 `超时 ≥ 间隔 × 3`）
- 移动网络建议 15/45：太密费电，太疏断线发现得晚
- 心跳帧里带 `rtt`（上次收包距今多久），服务端回包带自己的 ts，可算单向延迟

服务端两个实现都已处理 `ping` 帧，否则心跳会堆积无效请求。

### 4. 自动重连

0.7s → 8s 指数退避，6 次后放弃并提示；重连成功后自动重发一次 `session.list`。

## 用起来

1. 微信开发者工具 → 导入项目 → 目录选 `app/minis/`，appid 用测试号或自己的
2. 「服务器」页 → ＋ 新增 → 填地址 → 点「测试连接」（会真连一次、握手、拉一次列表，
   把协议版本/会话数/心跳配置显示出来）
3. 保存后跳「会话」页

公网部署三件套：

1. **wss**：Nginx 反代到本机 8787/20016 并配证书，注意 `proxy_read_timeout` 要够长
2. **socket 合法域名**：小程序后台「开发管理 → 服务器域名」登记，真机绕不过去
3. **认证**：公网暴露的 panel 建议配 `SBP_HMAC_KEYS`，别只靠 cookie

## 协议对应

| 小程序动作 | 帧 |
|---|---|
| 连接后首帧 | `hello{role, auth?}`（sbp-server 要求 token 在这一帧里） |
| 保活 | `ping{t}` → res `{ts}` |
| 进列表页 | `session.list` → 只回 `sid + 标题 + 状态 + 条数`，一行正文都不带 |
| 点开会话 | `session.attach`（回包里带当前 `prompt`）+ `session.history{limit:20}` |
| 上滑 | `session.history{before: <上一页最早的 seq>}` |
| 发消息 | `session.input{kind:"text"}` |
| 按键 | `session.input{kind:"key", key:"ESC"｜"UP"｜"C-C"｜…}` |
| 点选项 | `session.answer{pid, choice}`（要跟一段说明就带 `text`） |
| 忽略卡片 | `session.answer{pid, dismiss:true}` —— 只收卡片，不写终端 |
| 实时屏幕 | 服务端 evt `output.delta` |
| 选项出现/消失 | 服务端 evt `session.prompt`（`state: open / answered / gone`） |

## 测试（不开开发者工具也能验）

```bash
# 装 ws 库（只在测试用）
cd <node workspace> && npm i ws

cd app/minis
NODE_PATH=<node workspace>/node_modules node tests/sim.js ws://127.0.0.1:20016/ws
# 带公私钥：
NODE_PATH=... node tests/sim.js ws://127.0.0.1:20017/ws mac-mini-01 demo-secret-123

# 单独验 HMAC 开关（服务端要开 SBP_HMAC_KEYS）
NODE_PATH=... node tests/auth_check.js ws://127.0.0.1:20017/ws
```

`sim.js` 覆盖：地址解析 → 握手 → 心跳（真等 12 秒）→ 列表无正文 → 懒加载翻页 → 选项作答 → 过期保护。
`auth_check.js` 覆盖：不签名被拒 / 正确签名放行 / 错误签名被拒。

## 已知边界

- 消息正文截断 1200 字，屏幕区最多 60 行（点标题栏折叠）
- 切到后台或离开会话页会 `session.detach`，避免服务端白推
- 心跳超时判定依赖服务端回包，若反代层缓存了 WS，心跳会误判 —— 记得关掉反代的缓冲
