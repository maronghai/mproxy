import { insertTraffic, type TrafficRecord } from "./db";
import type { CertManager } from "./cert";
import { fork, type ChildProcess } from "child_process";
import { join } from "path";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "proxy-connection",
]);

const MAX_REQUEST_BODY = 10 * 1024 * 1024;
const MAX_RESPONSE_BODY = 50 * 1024 * 1024;
const FETCH_TIMEOUT = 30000;

function filterHeaders(headers: Headers, filterSet: Set<string>): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (!filterSet.has(k.toLowerCase())) {
      obj[k] = obj[k] ? obj[k] + ", " + v : v;
    }
  });
  return obj;
}

async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.length;
    if (totalSize > limit) { reader.cancel(); throw new Error("Body too large"); }
    chunks.push(value);
  }
  if (chunks.length === 0) return null;
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// ─── HTTP Proxy (Bun.serve) ─────────────────────────────────────────

export function createProxyServer(port: number) {
  const selfHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "0:0:0:0:0:0:0:0"]);

  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: async (req) => {
      const clientIP = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";

      if (req.method === "CONNECT") {
        return new Response("Use HTTPS proxy port (8443) for CONNECT", { status: 501 });
      }

      const startTime = Date.now();
      const method = req.method;
      const targetUrl = req.url;
      let target: URL;
      try { target = new URL(targetUrl); } catch {
        return new Response("Bad Request: Invalid URL", { status: 400 });
      }
      const targetPort = parseInt(target.port) || (target.protocol === "https:" ? 443 : 80);
      if (selfHosts.has(target.hostname) && targetPort === port) {
        return new Response("Loop Detected", { status: 508 });
      }

      let reqBodyBytes: Uint8Array | null = null;
      if (req.body) {
        try { reqBodyBytes = await readBodyWithLimit(req.body, MAX_REQUEST_BODY); }
        catch { return new Response("Request body too large", { status: 413 }); }
      }

      const forwardHeaders = filterHeaders(req.headers, HOP_BY_HOP_HEADERS);
      delete forwardHeaders["host"];
      forwardHeaders["host"] = target.host;

      const record: TrafficRecord = {
        method, url: targetUrl, host: target.hostname, port: targetPort,
        request_headers: JSON.stringify(forwardHeaders), request_body: reqBodyBytes,
        status_code: null, response_headers: null, response_body: null,
        duration_ms: null, client_ip: clientIP, error: null,
      };

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        let resp: Response;
        try {
          resp = await fetch(targetUrl, {
            method, headers: forwardHeaders, body: reqBodyBytes || undefined,
            redirect: "manual", signal: controller.signal,
          });
        } catch (fetchErr: any) { clearTimeout(timeout); throw fetchErr; }
        clearTimeout(timeout);
        const duration = Date.now() - startTime;
        const respBodyArrayBuffer = await resp.arrayBuffer();
        const respBodyBytes = new Uint8Array(respBodyArrayBuffer);
        const respHeaders = filterHeaders(resp.headers, HOP_BY_HOP_HEADERS);
        record.status_code = resp.status;
        record.response_headers = JSON.stringify(respHeaders);
        record.response_body = respBodyBytes.length <= MAX_RESPONSE_BODY ? respBodyBytes : null;
        record.duration_ms = duration;
        return new Response(respBodyBytes, { status: resp.status, headers: respHeaders });
      } catch (err: any) {
        record.duration_ms = Date.now() - startTime;
        record.error = err.message || String(err);
        if (err.name === "AbortError") return new Response("Gateway Timeout", { status: 504 });
        return new Response("Proxy Error", { status: 502 });
      } finally {
        try { insertTraffic(record); } catch (_) {}
      }
    },
  });
}

// ─── HTTPS Proxy with MITM ─────────────────────────────────────────
// Bun cannot do TLS MITM on raw sockets, so we spawn a Node.js subprocess
// that handles the TLS work. After CONNECT, we pipe clientSocket to the
// subprocess's local TLS server port. The subprocess decrypts and reports
// traffic back via IPC.

export function createHttpsProxyServer(port: number, certManager: CertManager) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require("node:net") as typeof import("node:net");

  const mitmScriptPath = join(__dirname, "..", "tls_mitm_server.cjs");

  // Start a persistent Node.js subprocess for MITM
  // CRITICAL: execPath must be "node" — Bun's TLS cannot do MITM on existing sockets
  const mitmProcess: ChildProcess = fork(mitmScriptPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    silent: true,
    execPath: "node",
  });

  let mitmReady = false;
  let mitmPort = 0;
  const pendingConnections: Array<{ clientSocket: import("node:net").Socket; target: string; initialData: Buffer; clientIP: string }> = [];

  mitmProcess.on("message", (msg: any) => {
    if (msg.type === "ready") {
      mitmReady = true;
      mitmPort = msg.port;
      console.log(`  [MITM] Node.js subprocess ready on port ${mitmPort}`);
      // Process any queued connections
      for (const pending of pendingConnections) {
        bridgeToMitm(pending.clientSocket, pending.target, pending.initialData, pending.clientIP);
      }
      pendingConnections.length = 0;
    } else if (msg.type === "traffic") {
      // Complete traffic record from subprocess (request + response)
      const record: TrafficRecord = {
        method: msg.method,
        url: msg.url,
        host: msg.host,
        port: msg.port,
        request_headers: msg.request_headers,
        request_body: msg.request_body ? Buffer.from(msg.request_body, "base64") : null,
        status_code: msg.status_code,
        response_headers: msg.response_headers,
        response_body: msg.response_body ? Buffer.from(msg.response_body, "base64") : null,
        duration_ms: msg.duration_ms,
        client_ip: msg.client_ip,
        error: msg.error || null,
      };
      try { insertTraffic(record); } catch (_) {}
    }
  });

  mitmProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.log(`  ${msg}`);
  });

  mitmProcess.on("error", (err) => {
    console.error(`  [MITM] subprocess error: ${err.message}`);
  });

  mitmProcess.on("exit", (code) => {
    console.error(`  [MITM] subprocess exited with code ${code}`);
    mitmReady = false;
  });

  // Send a cert to auto-start the subprocess (it will receive domain-specific certs later)
  certManager.getOrCreateCertAsync("localhost").then((c) => {
    mitmProcess.send({ type: "init", cert: c.cert, key: c.key });
  }).catch(() => {});

  const server = net.createServer((socket: import("node:net").Socket) => {
    let buffer = Buffer.alloc(0);

    socket.on("data", function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerStr = buffer.slice(0, headerEnd).toString();
      const lines = headerStr.split("\r\n");
      const requestLine = lines[0];
      if (!requestLine) { socket.destroy(); return; }
      const parts = requestLine.split(" ");
      const method = parts[0];
      const target = parts[1];

      if (method === "CONNECT" && target) {
        socket.removeListener("data", onData);
        const remainder = buffer.slice(headerEnd + 4);
        handleConnectMitm(socket, target, remainder);
      } else {
        socket.removeListener("data", onData);
        handleHttpViaNet(socket, buffer);
      }
    });

    socket.on("error", () => { try { socket.destroy(); } catch (_) {} });
  });

  server.on("error", (err: Error) => { console.error(`  [HTTPS] server error: ${err.message}`); });

  server.listen(port, "0.0.0.0", () => {
    console.log(`  HTTPS proxy: http://localhost:${port}`);
  });

  return server;

  function handleConnectMitm(
    clientSocket: import("node:net").Socket,
    target: string,
    initialData: Buffer,
  ) {
    const clientIP = (clientSocket.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";

    if (!mitmReady) {
      pendingConnections.push({ clientSocket, target, initialData, clientIP });
      console.log(`  [MITM] queuing connection (subprocess not ready yet)`);
      return;
    }

    bridgeToMitm(clientSocket, target, initialData, clientIP);
  }

  async function bridgeToMitm(
    clientSocket: import("node:net").Socket,
    target: string,
    initialData: Buffer,
    clientIP: string,
  ) {
    const parts = target.split(":");
    const hostname = parts[0]!;
    const targetPort = parseInt(parts[1] || "") || 443;

    console.log(`  [MITM] bridging ${hostname}:${targetPort} to Node.js subprocess`);

    // Get cert for this domain and send to subprocess
    try {
      const domainCert = await certManager.getOrCreateCertAsync(hostname);
      mitmProcess.send({ type: "cert", domain: hostname, cert: domainCert.cert, key: domainCert.key });
    } catch (err: any) {
      console.error(`  [MITM] cert error for ${hostname}: ${err.message}`);
      try { clientSocket.destroy(); } catch (_) {}
      return;
    }

    // Connect to the MITM subprocess's local port
    const localSocket = net.createConnection(mitmPort, "127.0.0.1");

    localSocket.on("error", (err: Error) => {
      console.error(`  [MITM] local socket error: ${err.message}`);
      try { clientSocket.destroy(); } catch (_) {}
      try { localSocket.destroy(); } catch (_) {}
    });

    clientSocket.on("error", (err: Error) => {
      console.error(`  [MITM] client error: ${err.message}`);
      try { localSocket.destroy(); } catch (_) {}
      try { clientSocket.destroy(); } catch (_) {}
    });

    localSocket.on("connect", () => {
      // Tell client the tunnel is established
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      // Send target info to subprocess via IPC (identified by localPort)
      const socketId = localSocket.localPort;
      mitmProcess.send({
        type: "connect",
        socketId,
        hostname,
        port: targetPort,
        clientIP,
      });

      // Bridge raw data bidirectionally — no delay needed, subprocess pauses the socket
      localSocket.on("data", (chunk: Buffer) => {
        try { clientSocket.write(chunk); } catch (_) {}
      });
      clientSocket.on("data", (chunk: Buffer) => {
        try { localSocket.write(chunk); } catch (_) {}
      });

      localSocket.on("end", () => { try { clientSocket.end(); } catch (_) {} });
      clientSocket.on("end", () => { try { localSocket.end(); } catch (_) {} });
      localSocket.on("close", () => { try { clientSocket.destroy(); } catch (_) {} });
      clientSocket.on("close", () => { try { localSocket.destroy(); } catch (_) {} });
    });
  }

  // ── Plain HTTP via raw socket ────────────────────────────────────

  function handleHttpViaNet(
    clientSocket: import("node:net").Socket,
    initialData: Buffer,
  ) {
    const headerEnd = initialData.indexOf("\r\n\r\n");
    const headerStr = initialData.slice(0, headerEnd).toString();
    const lines = headerStr.split("\r\n");
    const requestLine = lines[0] || "";
    const [, rawUrl] = requestLine.split(" ");
    const clientIP = (clientSocket.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";
    const startTime = Date.now();

    if (!rawUrl) { clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); clientSocket.destroy(); return; }

    let target: URL;
    try { target = new URL(rawUrl); } catch {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); clientSocket.destroy(); return;
    }

    const targetPort = parseInt(target.port) || (target.protocol === "https:" ? 443 : 80);
    const record: TrafficRecord = {
      method: requestLine.split(" ")[0] || "", url: rawUrl, host: target.hostname, port: targetPort,
      request_headers: "{}", request_body: null, status_code: null, response_headers: null,
      response_body: null, duration_ms: null, client_ip: clientIP, error: null,
    };

    const upstream = net.createConnection(targetPort, target.hostname, () => {
      upstream.write(initialData);
      upstream.on("data", (chunk: Buffer) => { clientSocket.write(chunk); });
      upstream.on("end", () => {
        record.duration_ms = Date.now() - startTime;
        try { insertTraffic(record); } catch (_) {}
        clientSocket.destroy();
      });
    });
    upstream.on("error", (err: Error) => {
      record.duration_ms = Date.now() - startTime;
      record.error = err.message;
      try { insertTraffic(record); } catch (_) {}
      clientSocket.destroy();
    });
    clientSocket.on("data", (chunk: Buffer) => { upstream.write(chunk); });
    clientSocket.on("error", () => { upstream.destroy(); });
  }
}
