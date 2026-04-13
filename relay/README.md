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
# Chrome 加载 extensions/rbc/
# 插件 popup 连接 ws://192.168.0.100:3000/ws

# 方案 2: Playwright 直连 BAP
cd relay
./start.sh
# 或手动: node playwright-relay.js
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
# Chrome 安装并加载 extensions/rbc/
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

**配置:** 编辑 `.env` 文件

**启动:**
```bash
cd relay
./start.sh
```

---

## 关键文件

```
relay/
├── .env                  # 配置文件（gateway, token, device 等）
├── start.sh              # 启动脚本（读取 .env）
├── playwright-relay.js   # Playwright 直连 BAP（方案 2）
└── package.json
```

---

## BAP 命令格式

BAP Gateway 使用以下命令格式：

```json
// Client → BAP Gateway
{ "type": "command", "id": 1, "method": "tabs.list", "params": {}, "targetDeviceId": "playwright-jerrypc" }

// BAP Gateway → Device (playwright-relay.js)
{ "type": "command", "id": 1, "method": "tabs.list", "params": {} }

// Device → BAP Gateway
{ "type": "command_response", "id": 1, "result": {...} }

// BAP Gateway → Client
{ "type": "command_response", "id": 1, "result": {...} }
```
