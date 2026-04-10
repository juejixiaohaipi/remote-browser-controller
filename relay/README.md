# RBC Relay

本地中转程序，解决 Chrome MV3 Service Worker 被杀导致 WebSocket 断开的问题。

## 架构

```
┌─────────────────────────┐       ┌─────────────────────────┐       ┌──────────────────┐
│  Chrome 浏览器           │       │  relay.exe / relay       │       │  BAP Server      │
│  ┌───────────────────┐  │       │                         │       │                  │
│  │  rbc-relay 插件   │  │  ws   │  localhost:18792         │  ws   │  ws://gateway    │
│  │  (MV3 extension) │──┼──────►│  ← token 验证 →         │──────►│  /ws             │
│  └───────────────────┘  │       │    消息双向转发          │       │                  │
└─────────────────────────┘       └─────────────────────────┘       └──────────────────┘
     Windows / Mac / Linux              Windows / Linux                 VPS (公网)
```

**为什么需要 relay：**
- Chrome MV3 的 Service Worker 会被 Chrome 自动终止（通常 5-30 秒）
- relay 是独立进程，不受 Chrome 管理，WebSocket 长连接稳定
- Chrome 插件只需连 `localhost`，relay 负责维持到远程服务器的连接

## 文件结构

```
relay/
├── relay.js          # 源码（需要 Node.js）
├── .env              # 配置文件（手动创建）
├── .env.example     # 配置模板
├── package.json
├── dist/
│   ├── relay        # Linux 可执行文件（已打包）
│   └── release/
│       ├── relay-linux  # Linux 版
│       ├── relay.js     # Windows 编译用源码
│       └── .env.example
└── README.md
```

## 快速开始

### 1. 获取程序

**Linux / VPS：**
```bash
cp dist/release/relay-linux ./relay
chmod +x relay
```

**Windows：**
```bash
# 方式 A：直接用 Node.js
node relay.js

# 方式 B：先安装 pkg 打包成 exe
npm install -g pkg
pkg relay.js -t node22-win-x64 -o relay.exe
```

### 2. 配置

```bash
cp .env.example .env
nano .env   # 修改配置
```

`.env` 配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BAP_GATEWAY_URL` | BAP Gateway WebSocket 地址（包含 /ws） | `ws://192.168.0.100:3000/ws` |
| `RELAY_PORT` | 本地监听端口（Chrome 插件连接到此） | `18792` |
| `DEVICE_ID` | 设备 ID（在 Gateway 上显示） | `rbc-relay` |
| `DEVICE_NAME` | 设备名称 | `RBC-Relay` |
| `TOKEN` | 连接 BAP Gateway 的认证 token | BAP server 的 DEFAULT_TOKEN |

### 3. 启动

```bash
./relay
# 或带命令行参数
./relay --gateway ws://1.2.3.4:3000/ws --port 18792 --device-name "我的电脑"
```

### 4. Chrome 插件配置

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extensions/rbc-relay/` 文件夹
5. 点击插件图标，填入：
   - **Relay Token**：与 relay `.env` 里的 `TOKEN` 一致
   - **Relay Port**：与 relay `.env` 里的 `RELAY_PORT` 一致（默认 18792）
   - **设备名称**：自定义
6. 点击「连接」

### 5. 验证

```bash
# relay 本地健康检查
curl http://127.0.0.1:18792/health

# BAP Gateway 在线设备
curl http://192.168.0.100:3000/api/debug/gateway
```

## 部署多台设备

每台设备都需要：
1. 运行一个 relay 进程
2. 安装 rbc-relay 插件

新增设备时，BAP Server 端无需任何操作。

## 开机自启

### Linux (systemd)

```bash
sudo nano /etc/systemd/system/rbc-relay.service
```

```ini
[Unit]
Description=RBC Relay
After=network.target

[Service]
ExecStart=/home/jerry/relay/relay
WorkingDirectory=/home/jerry/relay
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable rbc-relay
sudo systemctl start rbc-relay
```

### Windows (任务计划程序)

```powershell
# 以管理员身份运行 PowerShell
$action = New-ScheduledTaskAction -Execute "C:\path\to\relay.exe"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "RBC Relay" -Description "RBC Relay auto-start"
```

## 命令行参数

所有配置都可以用命令行参数覆盖 `.env`：

```bash
./relay \
  --gateway ws://1.2.3.4:3000/ws \
  --port 18792 \
  --device-id my-pc \
  --device-name "My PC" \
  --token YOUR_TOKEN_HERE
```

## 故障排查

**Chrome 插件显示"连接失败"**
- 确认 relay 正在运行：`curl http://127.0.0.1:18792/health`
- 确认 relay 状态是 `"gateway": "connected"`
- 确认插件填的 Relay Token 与 relay `.env` 里的 TOKEN 一致

**relay 显示 "Gateway connection error"**
- 确认 BAP Gateway 可达：`curl http://192.168.0.100:3000/health`
- 确认 BAP Gateway 的 WebSocket 路径是 `/ws`
- 确认 TOKEN 与 BAP server 的 DEFAULT_TOKEN 一致

**无法连接 localhost:18792**
- 确认端口没被占用：`lsof -i :18792`
- 尝试换一个端口：`./relay --port 18793`

## 与 rbc 插件的关系

| | rbc 插件（直接连接） | rbc-relay 插件（relay 中转） |
|---|---|---|
| MV3 SW 被杀 | ❌ 连接断，5-30 秒重连循环 | ✅ relay 独立进程，不受影响 |
| 需要额外程序 | ❌ 不要 | ✅ relay 常驻 |
| 适用场景 | Linux / 稳定的 Chrome | Windows / MV3 不稳定的场景 |
| 新增设备 | 装插件 | 装插件 + 跑 relay |
