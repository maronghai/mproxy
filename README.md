# Mproxy - HTTP/HTTPS Proxy with Traffic Capture

An HTTP/HTTPS forward proxy built with Bun + Node.js that automatically captures all requests and responses to a SQLite database, with a built-in Web UI to view captured traffic.

## Features

- HTTP forward proxy
- HTTPS MITM proxy (auto-generated certificates, requires CA installation)
- Complete request/response capture to SQLite
- Built-in Web UI for traffic inspection
- Auto-formatted JSON request body display
- Dark theme interface with auto-refresh

## Architecture

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

HTTPS traffic is handled by receiving CONNECT requests at the Bun proxy, then bridging the socket via IPC to a Node.js subprocess for TLS decryption and plaintext logging.

## Quick Start

### Install Dependencies

```bash
bun install
```

### Start the Server

```bash
bun run start
```

Or development mode (with hot reload):

```bash
bun run dev
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8080` | HTTP proxy port |
| `HTTPS_PORT` | `8443` | HTTPS MITM proxy port |
| `VIEWER_PORT` | `3000` | Web UI port |
| `DB_PATH` | `proxy.db` | SQLite database path |
| `DATA_DIR` | `.data` | Certificate and key storage directory |

### Using the Proxy

**curl (HTTP):**

```bash
curl -x http://localhost:8080 http://example.com
```

**curl (HTTPS):**

```bash
curl -x http://localhost:8443 https://example.com --insecure
```

**Browser:**

Configure proxy settings in your browser:

```
HTTP Proxy:  localhost:8080
HTTPS Proxy: localhost:8443
```

### Installing CA Certificate (Required for HTTPS)

To view HTTPS traffic in plaintext, add the CA certificate to your system trust store:

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
sudo cp .data\ca-cert.pem /usr/local/share/ca-certificates/mproxy-ca.crt
sudo update-ca-certificates
```

### Viewing Traffic

Open your browser and navigate to: `http://localhost:3000`

## Project Structure

```
├── index.ts              # Entry point
├── tls_mitm_server.cjs   # Node.js TLS MITM subprocess
├── src/
│   ├── db.ts             # SQLite database operations
│   ├── cert.ts           # CA and domain certificate generation
│   ├── proxy.ts          # HTTP + HTTPS proxy server
│   └── viewer.ts         # Web UI and API
├── .data/                # CA certificate and domain certificate storage
├── package.json
└── tsconfig.json
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/list?limit=50&offset=0` | Get traffic list |
| `GET /api/detail/:id` | Get single traffic detail |
| `GET /api/stats` | Get statistics |

## Database Schema

```sql
CREATE TABLE traffic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,           -- HTTP method
  url TEXT NOT NULL,              -- Request URL
  host TEXT,                      -- Target host
  port INTEGER,                   -- Target port
  request_headers TEXT,           -- Request headers (JSON)
  request_body BLOB,              -- Request body
  status_code INTEGER,            -- Response status code
  response_headers TEXT,          -- Response headers (JSON)
  response_body BLOB,             -- Response body
  created_at TEXT,                -- Creation time
  duration_ms INTEGER,            -- Request duration (ms)
  client_ip TEXT,                 -- Client IP
  error TEXT                      -- Error message
);
```

## Dependencies

- [Bun](https://bun.sh/) - JavaScript runtime (proxy server + Web UI)
- [Node.js](https://nodejs.org/) - TLS MITM subprocess (must be installed and in PATH)
- `bun:sqlite` - SQLite database (built into Bun)
- `@peculiar/x509` - X.509 certificate generation
- `node:net` / `node:tls` - TCP/TLS connection handling

## License

MIT
