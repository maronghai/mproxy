# Zai - HTTP/HTTPS Proxy with Traffic Capture

基于 Bun + Node.js 构建的 HTTP/HTTPS 正向代理，自动将所有请求和响应保存到 SQLite 数据库，并提供 Web UI 查看捕获的流量。

## 功能

- HTTP 正向代理
- HTTPS MITM 代理（自动生成证书，需安装 CA）
- 所有请求/响应完整保存到 SQLite
- 内置 Web UI 查看捕获的流量
- 支持 JSON 请求体自动格式化显示
- 暗色主题界面，自动刷新

## 架构

```
┌────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Client     │────▶│  Bun Proxy       │────▶│  Target Server      │
│  (curl/     │     │  (HTTP + HTTPS)  │     │  (httpbin.org etc)  │
│   browser)  │     │                  │     │                     │
└────────────┘     │  port 8080 (HTTP)│     └─────────────────────┘
                   │  port 8443 (HTTPS)│
                   └──────┬───────────┘
                          │ fork (IPC)
                   ┌──────▼───────────┐
                   │  Node.js Subprocess│
                   │  (TLS MITM)       │
                   │  tls_mitm_server.cjs│
                   └──────────────────┘
```

HTTPS 流量由 Bun 代理接收 CONNECT 请求后，通过 IPC 将 socket 桥接到 Node.js 子进程进行 TLS 解密和明文记录。

## 快速开始

### 安装依赖

```bash
bun install
```

### 启动服务

```bash
bun run start
```

或开发模式（热重载）：

```bash
bun run dev
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | `8080` | HTTP 代理端口 |
| `HTTPS_PORT` | `8443` | HTTPS MITM 代理端口 |
| `VIEWER_PORT` | `3000` | Web UI 端口 |
| `DB_PATH` | `proxy.db` | SQLite 数据库路径 |
| `DATA_DIR` | `.data` | 证书和密钥存储目录 |

### 使用代理

**curl (HTTP):**

```bash
curl -x http://localhost:8080 http://example.com
```

**curl (HTTPS):**

```bash
curl -x http://localhost:8443 https://example.com --insecure
```

**浏览器:**

在浏览器代理设置中配置：

```
HTTP 代理:  localhost:8080
HTTPS 代理: localhost:8443
```

### 安装 CA 证书（HTTPS 需要）

要查看 HTTPS 流量的明文内容，需要将 CA 证书添加到系统信任列表：

**Windows:**
```bash
certutil -addstore -f "Root" .data\ca-cert.pem
```

**macOS:**
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain .data\ca-cert.pem
```

**Linux:**
```bash
sudo cp .data\ca-cert.pem /usr/local/share/ca-certificates/zai-ca.crt
sudo update-ca-certificates
```

### 查看流量

打开浏览器访问：`http://localhost:3000`

## 项目结构

```
├── index.ts              # 入口文件
├── tls_mitm_server.cjs   # Node.js TLS MITM 子进程
├── src/
│   ├── db.ts             # SQLite 数据库操作
│   ├── cert.ts           # CA 和域名证书生成
│   ├── proxy.ts          # HTTP + HTTPS 代理服务器
│   └── viewer.ts         # Web UI 和 API
├── .data/                # CA 证书和域名证书存储
├── package.json
└── tsconfig.json
```

## API 接口

| 端点 | 说明 |
|------|------|
| `GET /api/list?limit=50&offset=0` | 获取流量列表 |
| `GET /api/detail/:id` | 获取单条流量详情 |
| `GET /api/stats` | 获取统计信息 |

## 数据库结构

```sql
CREATE TABLE traffic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,           -- HTTP 方法
  url TEXT NOT NULL,              -- 请求 URL
  host TEXT,                      -- 目标主机
  port INTEGER,                   -- 目标端口
  request_headers TEXT,           -- 请求头 (JSON)
  request_body BLOB,              -- 请求体
  status_code INTEGER,            -- 响应状态码
  response_headers TEXT,          -- 响应头 (JSON)
  response_body BLOB,             -- 响应体
  created_at TEXT,                -- 创建时间
  duration_ms INTEGER,            -- 请求耗时 (ms)
  client_ip TEXT,                 -- 客户端 IP
  error TEXT                      -- 错误信息
);
```

## 依赖

- [Bun](https://bun.sh/) - JavaScript 运行时（代理服务器 + Web UI）
- [Node.js](https://nodejs.org/) - TLS MITM 子进程（需安装并在 PATH 中）
- `bun:sqlite` - SQLite 数据库（Bun 内置）
- `@peculiar/x509` - X.509 证书生成
- `node:net` / `node:tls` - TCP/TLS 连接处理

## 许可

MIT
