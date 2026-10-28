# sbp-minis · SBP remote-session control mini-program

Drive the agent session on your computer from your phone: the list shows one session per tmux group;
tap in to pull the latest 20 messages, scroll up for earlier ones; when the agent lays out "1/2/3" options
on the terminal, here they become tappable buttons.

The protocol follows [SBP v0.1](https://github.com/sbp4ai/sbp-spec/blob/main/spec/SBP-0.1.md) +
[interaction-extension v0.2](https://github.com/sbp4ai/sbp-spec/blob/main/spec/SBP-0.2-interaction.md).
The backend can be `sbp-server` or the `panel` inside `sbp-agent` (tmux-claude-panel) — both frame sets line up with this mini-program.

> This repository is the repo root (no longer nested under `app/minis/`); follow the actual tree in the repo.

## Directory

```
app/
├── app.js / app.json / app.wxss      global (server config persistence, global protocol singleton)
├── utils/sbp.js                     protocol client: address parse, REST polling + WS long-connection dual channel, heartbeat, auto-reconnect
├── utils/hmac.js                    pure-JS HMAC-SHA256 (mini-program has no WebCrypto, signs by itself)
├── pages/settings/                  address, auth, transport, heartbeat → one-tap connection test
├── pages/index/                     session list (index only, no body)
├── pages/session/                   message stream + live screen + option cards + input
└── tests/                           mock wx.* in Node and run a real connection, no devtools needed
```

## Settings page — four things

### 1. Server address (one box)

```
wss://sbp.example.com/ws     → wss + 443 + /ws
ws://192.168.1.9:20016/ws    → ws + 20016 + /ws
1.2.3.4:8787                 → default wss + 8787 + /ws
```

Scheme omitted defaults to `wss`; port omitted fills 443/80 by scheme; path omitted fills `/ws`.

### 1.1 Transport (new)

The settings page offers two transports, **REST polling by default**:

- **REST polling (default)**: periodically `GET /api/index` + `/api/state` + `/api/history`, all with `ETag`
  (304 with no body when unchanged); writes go through `POST /api/rpc`. **No long connection, most server-friendly**,
  and no "WS killed in background" embarrassment. Poll interval is set in "polling interval" (default 5s).
- **WebSocket long connection**: only opened when explicitly selected. Switch only when you truly need lowest latency;
  auto-degrades back to REST on connect failure.

Both transports are fully transparent to the page; `utils/sbp.js` exposes the same `list/attach/history/input/answer/key`
semantics — the only difference is "does this frame go over REST or WS".

### 2. Auth

| Mode | Fill in | Server side |
|---|---|---|
| none | — | `--no-auth` panel |
| Token | server-issued token | sbp-server device binding |
| Cookie | `panel_session=xxx` | cookie after panel login |
| Bearer | JWT | self-built gateway |
| **asymmetric-key HMAC** | public KeyId + private Secret | `SBP_HMAC_KEYS=kid:secret` in panel's `.env` |

HMAC signature content: `HMAC-SHA256(secret, "sbp1\n{keyId}\n{ts}\n{nonce}")`. The key itself never travels; only ts/nonce/sig are sent,
and the server recomputes to compare; a ts skew beyond 5 minutes is rejected (replay protection).

Why not Ed25519: the mini-program has no native asymmetric-signing capability; forcing a port would slow startup.
We use a symmetric key here; the "public key" in config is just the KeyId that identifies which key to use.

Server side (panel) sets in `.env`:

```bash
SBP_HMAC_KEYS=mac-mini-01:a-long-random-string,macbook-pro:another-string
```

Once set, a signature is **mandatory** to connect; if unset, it falls back to cookie / `--no-auth`.

### 3. Heartbeat (interval / timeout)

> Only effective in WebSocket mode; REST polling has no long connection, so no heartbeat needed.

The mini-program cannot get WS-level ping, so it uses an application-level heartbeat: send a `ping` frame every `interval` seconds;
if not a single byte is received within `timeout` seconds, the line is declared dead → close actively → reconnect.

- interval default 20s, timeout default 60s (code enforces `timeout ≥ interval × 3`)
- mobile networks suggest 15/45: too dense wastes battery, too sparse delays disconnect detection
- the heartbeat frame carries `rtt` (how long since last packet); the server echoes its own ts, so one-way latency is computable

Both server implementations already handle the `ping` frame, otherwise heartbeats would pile up无效 requests.

### 4. Auto-reconnect

0.7s → 8s exponential backoff, give up and prompt after 6 tries; on successful reconnect, automatically re-send one `session.list`.

## Using it

1. WeChat DevTools → Import Project → select the `app/` directory, appid use a test number or your own
2. "Server" page → ＋ Add → fill address → tap "Test connection" (really connects once, handshakes, pulls a list,
   shows protocol version / session count / heartbeat config)
3. After saving, jump to the "Sessions" page

Public deployment three-piece set:

1. **wss**: Nginx reverse-proxy to local 8787/20016 with a cert; note `proxy_read_timeout` must be long enough
2. **socket legal domain**: register in mini-program console "Development Management → Server Domain"; unavoidable on real devices
3. **auth**: a publicly exposed panel should set `SBP_HMAC_KEYS`, not rely on cookie alone

## Protocol mapping

| Mini-program action | Frame |
|---|---|
| first frame after connect | `hello{role, auth?}` (sbp-server requires token in this frame) |
| keep-alive | `ping{t}` → res `{ts}` |
| enter list page | `session.list` → only returns `sid + title + status + count`, no body at all |
| open a session | `session.attach` (response carries current `prompt`) + `session.history{limit:20}` |
| scroll up | `session.history{before: <seq of earliest in previous page>}` |
| send message | `session.input{kind:"text"}` |
| key press | `session.input{kind:"key", key:"ESC"｜"UP"｜"C-C"｜…}` |
| tap option | `session.answer{pid, choice}` (add `text` for an explanation) |
| dismiss card | `session.answer{pid, dismiss:true}` — receive the card only, don't write to terminal |
| live screen | server evt `output.delta` |
| option appears/disappears | server evt `session.prompt` (`state: open / answered / gone`) |

## Testing (no devtools needed)

```bash
# install ws lib (test only)
cd <node workspace> && npm i ws

cd app
NODE_PATH=<node workspace>/node_modules node tests/sim.js ws://127.0.0.1:20016/ws
# with asymmetric key:
NODE_PATH=... node tests/sim.js ws://127.0.0.1:20017/ws mac-mini-01 demo-secret-123

# verify HMAC on/off separately (server must enable SBP_HMAC_KEYS)
NODE_PATH=... node tests/auth_check.js ws://127.0.0.1:20017/ws
```

`sim.js` covers: address parse → handshake → heartbeat (really waits 12s) → list without body → lazy-load paging → option answer → expiry protection.
`auth_check.js` covers: rejected without signature / allowed with correct signature / rejected with wrong signature.

## Known limits

- Message body truncated at 1200 chars; screen area max 60 lines (collapse via title bar)
- Switching to background or leaving the session page triggers `session.detach` to avoid wasted server pushes
- Heartbeat timeout depends on the server's reply; if a proxy layer caches WS, heartbeat misjudges — remember to turn off the proxy's buffering

---

# sbp-minis · SBP 远程会话控制小程序（中文）

手机上看电脑上的 agent 会话：列表是 tmux 分组下的一条条会话，点进去才拉最新 20 条，
上滑继续翻更早；agent 把「1/2/3」选项摆到终端上时，这里是一排可以点的按钮。

协议走 [SBP v0.1](https://github.com/sbp4ai/sbp-spec/blob/main/spec/SBP-0.1.md) +
[交互提示扩展 v0.2](https://github.com/sbp4ai/sbp-spec/blob/main/spec/SBP-0.2-interaction.md)，
后端可以是 `sbp-server`，也可以是 `sbp-agent` 里的 `panel`（tmux-claude-panel），两端帧名这套小程序都对得上。

> 本仓库即仓库根（不再嵌套在 `app/minis/` 下），目录树请以仓库实际结构为准。

## 目录

```
app/
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

1. 微信开发者工具 → 导入项目 → 目录选 `app/`，appid 用测试号或自己的
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

cd app
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
