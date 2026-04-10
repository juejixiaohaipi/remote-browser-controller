# Remote Browser Controller

Chrome 扩展合集，通过 WebSocket 连接 BAP Server 控制远程 Chrome 浏览器。

## 扩展列表

| 扩展 | 说明 | 目录 |
|------|------|------|
| **RBC** | 远程浏览器控制（导航、截图、表单、鼠标等） | `extensions/rbc/` |
| **GTool** | 密码输入框眼睛图标去除器，防误点暴露密码 | `extensions/gtool/` |

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
Chrome Extension (RBC)
    │
    │  WebSocket /ws
    ▼
BAP Server :3000
    │
    ├── REST API (/api/*)    → Web UI / OpenClaw
    └── WebSocket (/ws)      → 浏览器控制
         └─ 合并了原 RBC Server 逻辑
```

BAP Server 是统一入口，同时提供任务调度和浏览器控制能力。

## OpenClaw Skill

RBC 的 OpenClaw Skill 位于：

```
projects/browser-automation-platform/skills/rbc/
```

## 快速验证连接

```bash
# 用 wscat 连接测试
npx wscat -c ws://localhost:3000/ws
# 发送认证：
# {"type":"auth","token":"XERJS7O4y_NF4fzyAlalN3i0udAd6wuT","deviceId":"test","role":"browser"}
# 应收到：{"type":"auth_ok","sessionId":"..."}
```
