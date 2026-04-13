# Remote Browser Controller (RBC)

远程浏览器控制能力，有两种实现方式：
1. **Chrome Extension (RBC)** — 浏览器插件方式
2. **Playwright** — Playwright 直接控制浏览器

所有方式均通过 WebSocket 连接 BAP Server :3000。

## 浏览器控制实现

| 方案 | 说明 | 目录 |
|------|------|------|
| **RBC Extension** | Chrome 插件方式 | `extensions/rbc/` |
| **Playwright** | Playwright 直接控制 | `relay/playwright-relay.js` |
| **GTool** | 密码输入框眼睛图标去除器 | `extensions/gtool/` |

## 安装任意扩展

```bash
# Chrome → chrome://extensions → 开发者模式 → 加载已解压扩展程序
# 选择对应扩展目录，如 extensions/rbc/
```

## 连接到 BAP Server

各扩展 popup 界面填写：

| 字段 | 值 |
|------|-----|
| Server URL | `ws://你的BAP服务器:3000/ws` |
| Token | `XERJS7O4y_NF4fzyAlalN3i0udAd6wuT`（可在 BAP `.env` 中修改） |
| Device ID | 任意唯一字符串 |

> ⚠️ BAP Server 必须先启动，WebSocket 端口为 **3000**（RBC 旧版独立部署的 8080 端口已废弃）。

## 添加新扩展

在 `extensions/` 下新建目录即可：

```
extensions/
├── rbc/           # 远程浏览器控制
├── gtool/         # 密码框工具
└── your-plugin/   # 新扩展
    ├── manifest.json
    ├── background.js
    └── ...
```

## 架构说明

```
BAP Client (AI/测试脚本)
  → WebSocket ws://192.168.0.100:3000/ws (role: client)
        ↓
  BAP Gateway :3000
        ↓
  ┌───────────────────────────────────────┐
  │  方案 1: Chrome Extension (RBC)       │
  │  offscreen.html ──ws──▶ BAP Gateway  │
  │  (extensions/rbc/)                    │
  ├───────────────────────────────────────┤
  │  方案 2: Playwright                   │
  │  playwright-relay.js ──ws──▶ BAP      │
  │  (relay/playwright-relay.js)          │
  └───────────────────────────────────────┘
```

## 两套方案对比

| 维度 | 方案 1: RBC Extension | 方案 2: Playwright |
|---|---|---|
| 浏览器 | 真实用户 Chrome（带登录态） | headless Chromium |
| 部署形态 | Chrome 插件，用户本地跑 | Node 进程，任何机器都行 |
| MV3 SW 稳定性 | ⚠️ 偶发 context invalidated | ✅ 不受影响 |
| DOM 操作 | content script 注入 | Playwright API |
| Cookie/登录态 | ✅ 沿用用户本地 session | 需自己管理 storageState |
| 对外协议 | 同（BAP `/ws` role=browser） | 同 |

两套方案**对外协议完全一致**，BAP 服务端不区分。可按账号混用（Amazon 个人账号用方案 1 保留 MFA 登录态，平台类账号用方案 2 在服务器跑 headless）。

## OpenClaw Skill

RBC 的 OpenClaw Skill 位于：

```
/home/jerry/clawd/skills/rbc/SKILL.md
```

## 快速验证连接

```bash
# 用 wscat 连接测试
npx wscat -c ws://localhost:3000/ws
# 发送认证：
# {"type":"auth","token":"XERJS7O4y_NF4fzyAlalN3i0udAd6wuT","deviceId":"test","role":"browser"}
# 应收到：{"type":"auth_ok","sessionId":"..."}
```

## Gateway 通信协议

**Browser 侧（扩展 / Playwright）连接时**：
```json
{ "type": "auth", "token": "...", "deviceId": "my-pc", "deviceName": "MyPC", "browserType": "chrome", "role": "browser" }
```
服务端认证通过回：
```json
{ "type": "auth_ok", "sessionId": "uuid...", "serverVersion": "1.0.0" }
```

**命令下发（server → browser）**：
```json
{ "type": "command", "id": "cmd-uuid", "method": "element.click", "params": { "selector": "e5" } }
```

**命令响应（browser → server）**：
```json
{ "type": "command_response", "id": "cmd-uuid", "result": { "success": true } }
// 或
{ "type": "command_response", "id": "cmd-uuid", "error": { "code": -32000, "message": "..." } }
```

**事件上报（browser → server，单向）**：
```json
{ "type": "event", "event": "page.loaded", "data": { "url": "...", "title": "...", "tabId": 1 } }
```

## 命令命名约定

命令名跟 BAP 服务端 `commands.ts` 注册的完全一致。**分两类**：

### Background 层处理（需要 `chrome.tabs` / `chrome.downloads` API）

| 命令 | 参数 | 说明 |
|---|---|---|
| `browser.navigate` | `{ url, tabId? }` | 导航 |
| `browser.back` / `browser.forward` | `{ tabId? }` | 后退/前进 |
| `browser.reload` | `{ tabId?, bypassCache? }` | 刷新 |
| `browser.close` | `{ tabId? }` | 关闭当前 tab（扩展不能退出浏览器进程） |
| `tabs.create` | `{ url?, active? }` | 新开 tab |
| `tabs.close` | `{ tabId? }` | 关 tab |
| `tabs.switch` | `{ tabId }` | 切换活动 tab |
| `tabs.list` | `{ allWindows? }` | 列出 tab |
| `downloads.list` | `{ query? }` | 列出下载 |
| `file.delete` | `{ id }` | 删除本地下载文件 |

> 旧别名 `browser.newTab` / `closeTab` / `switchTab` / `listTabs` 仍然兼容，但推荐用 `tabs.*`。

### Content Script 层处理（操作 DOM）

| 类别 | 命令 |
|---|---|
| 快照 | `browser.snapshot` (返回含 e# ref 的可访问性树) |
| 元素 | `element.click/type/select/check/hover/scroll/clear` |
| 键鼠 | `keyboard.press` (含 modifiers)、`mouse.click` (x,y) |
| 页面 | `page.fill/getTitle/getUrl/getContent/getHtml/screenshot/getCookies/getLocalStorage/evaluate` |
| 表单 | `form.fill/submit/clear` |
| 对话框 | `dialog.accept/dismiss/getText` |
| 等待 | `wait.forSelector/forNavigation/forNetworkIdle` |
| 求值 | `eval.js` (在页面上下文执行，非 isolated world) |
| 文件 | `file.download/read/upload/getDownloaded` |

所有命令都支持 `params.tabId` 指定目标 tab；省略则路由到 active tab。

## MV3 架构要点（仅方案 1）

Chrome MV3 的 Service Worker 会被随时终止，所以扩展拆成：

```
popup.html                       — 用户配置 UI
  ↕ chrome.runtime.sendMessage
background.js (Service Worker)   — 消息路由、chrome.tabs API、downloads 监听
  ↕ chrome.runtime.connect(port)
offscreen.html                   — ⭐ WebSocket 长连接（SW 被杀也不受影响）
  ↕ chrome.tabs.sendMessage
content.js (每个页面注入)         — DOM 操作、快照、事件拦截
```

**offscreen document 是 MV3 下唯一能稳定维持 WebSocket 的地方**。Background SW 只做消息转发，WebSocket 生命周期完全在 offscreen。

### Orphan content script 问题

**现象**：`chrome://extensions` 点"重新加载"扩展后，页面里已注入的旧 content script 变成 orphan——`chrome.runtime` 成 undefined，再访问就 `TypeError: Cannot read properties of undefined`。

**处理**：`content.js` 的 `isContextValid()` 守卫会检测到并**停止重试**。看到 `[RBC] Extension context invalidated` 日志就刷新页面——只有刷新才会重新注入最新 content script。

### 连接状态同步

popup 读的是 `background.js` 里 `conn.status`，**权威状态**在 background。如果页面 content script 已 orphan 但 background 还活着，popup 仍会显示 `connected`（因为 WebSocket 确实连着）——此时远程命令能下发到 background，但到 orphan 页面的 `chrome.tabs.sendMessage` 会 timeout。换活动 tab 到正常页面即可恢复。

## 故障排查

| 现象 | 排查 |
|---|---|
| popup 显示 "Extension context invalid" | 页面 content script orphan，刷新当前页 |
| 命令 timeout | 检查 `/api/sessions` 目标设备是否在线；检查页面 content script 是否注入 |
| WebSocket 频繁断连 | Chrome 屏蔽 mixed content（https 页面连 ws://）；改用 wss:// 或改 BAP 加 TLS |
| BAP 端看不到命令响应 | 检查 background.js 日志，`sendResponse` 可能被异常吞掉 |
| 新装扩展连不上 | 先验证 `curl http://BAP:3000/health`；再检查 token 是否与 BAP `.env` 一致 |
