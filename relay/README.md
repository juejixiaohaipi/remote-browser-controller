# Browser Automation — 2 Solutions

所有方案都连接 BAP Gateway (:3000)，控制 jerry-PC 的浏览器。

---

## 方案对比

| # | 名称 | 连接路径 | 状态 |
|---|------|---------|------|
| 1 | **Chrome Extension (RBC)** | 插件 → BAP (直连) | ✅ 就位 |
| 2 | **Playwright 直连** | Playwright → BAP (直连) | ✅ 就位 |

---

## 快速启动

```bash
# 方案 1: Chrome Extension (RBC) 直连 BAP
# Chrome 加载 browsers/rbc-extension/
# 插件 popup 连接 ws://192.168.0.100:3000/ws

# 方案 2: Playwright 直连 BAP
node playwright-relay.js --browser chromium
```

---

## 方案 1: Chrome Extension (RBC) 直连 BAP

**架构:** Chrome Extension (offscreen + content) ──ws──▶ BAP Gateway :3000

```
Chrome (RBC 插件)
  ├── offscreen.html: WebSocket 保持连接
  ├── content.js:     注入页面，控制 DOM
  └── background.js: 路由消息

BAP Gateway: ws://192.168.0.100:3000
```

- 插件直接连接 BAP WebSocket，不需要 relay.js 中转
- 插件通过 `chrome.runtime.connect` + offscreen document 保持长连接
- ⚠️ MV3 service worker 不稳定，Deepin Chrome 环境中 context invalidated 频繁

**启动:**
```bash
# Chrome 安装并加载 browsers/rbc-extension/
# 插件 popup 连接 ws://192.168.0.100:3000/ws
```

---

## 方案 2: Playwright 直连 BAP

**架构:** Playwright ──ws──▶ BAP Gateway :3000

```
Playwright (chromium headless)
  └── playwright-relay.js ──ws──▶ BAP Gateway
```

- playwright-relay.js 直接连接 BAP WebSocket 协议，不需要 relay.js
- 将 BAP 命令转换为 Playwright API 调用
- ✅ 不需要 Chrome 插件，不受 MV3 service worker 影响
- ✅ 直连 BAP，少一跳，更简单

**启动:**
```bash
cd /home/jerry/projects/remote-browser-controller/relay
node playwright-relay.js --browser chromium
```

---

## 关键文件

```
relay/
├── relay.js              # relay 中转服务（给其他跨网络场景用）
├── cdp-relay.js          # CDP bridge（备用方案）
├── playwright-relay.js   # Playwright 直连 BAP（方案 2）
├── start.sh              # 启动脚本
└── browsers/
    ├── rbc-extension/       # RBC Chrome 插件（方案 1）
    └── openclaw-extension/  # OpenClaw Browser Relay（参考）
```

---

## relay.js 协议

relay.js 同时支持两种 extension 连接协议：

### 协议 A: BAP auth (旧版 / 我们的实现)
```json
// Extension → relay.js
{ "type": "auth", "token": "XERJS7O4y...", "deviceId": "rbc-jerrypc" }

// relay.js → BAP Gateway
{ "type": "auth", "token": "XERJS7O4y...", "deviceId": "rbc-jerrypc", ... }

// BAP → Extension (via relay)
{ "type": "command", "id": 1, "method": "...", "params": {} }
```

### 协议 B: OpenClaw connect (OpenClaw Browser Relay 扩展用)
```json
// BAP Gateway → relay.js
{ "type": "event", "event": "connect.challenge", "payload": {...} }

// relay.js → Extension
{ "type": "event", "event": "connect.challenge", "payload": {...} }

// Extension → relay.js
{ "type": "req", "id": "...", "method": "connect", "params": {...} }
```

---

## BAP 命令格式

BAP Gateway 使用以下命令格式：

```json
// Client → BAP Gateway
{ "type": "command", "id": 1, "method": "tabs.list", "params": {}, "targetDeviceId": "cdp-bridge-jerrypc" }

// BAP Gateway → Device (cdp-relay.js / playwright-relay.js)
{ "type": "command", "id": 1, "method": "tabs.list", "params": {} }

// Device → BAP Gateway
{ "type": "command_response", "id": 1, "result": {...} }

// BAP Gateway → Client
{ "type": "command_response", "id": 1, "result": {...} }
```
