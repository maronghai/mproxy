#!/usr/bin/env node
// tls_mitm_server.js - Node.js HTTPS MITM proxy subprocess
const net = require("net");
const tls = require("tls");

let cert = null;
let key = null;

const certCache = new Map();
const pendingConns = new Map();

process.on("message", (msg) => {
  if (msg.type === "init") {
    cert = msg.cert;
    key = msg.key;
  } else if (msg.type === "cert") {
    certCache.set(msg.domain, { cert: msg.cert, key: msg.key });
  } else if (msg.type === "connect") {
    pendingConns.set(msg.socketId, {
      hostname: msg.hostname,
      port: msg.port,
      clientIP: msg.clientIP,
    });
  }
});

process.on("error", (err) => {
  process.stderr.write(`[node-mitm] process error: ${err.message}\n`);
});

const server = net.createServer((clientSocket) => {
  // PAUSE immediately — prevent data loss before TLS server wraps this socket.
  // Without this, the ClientHello from the client arrives while the socket is in
  // flowing mode with no handler, and the data is silently discarded.
  clientSocket.pause();

  const startTime = Date.now();
  const socketId = clientSocket.remotePort;
  process.stderr.write(`[node-mitm] new connection socketId=${socketId}\n`);

  // Wait briefly for the IPC connect message to arrive
  const checkAndMitm = () => {
    const targetInfo = pendingConns.get(socketId);
    if (!targetInfo) {
      // Retry once after a short delay
      setTimeout(() => {
        const retry = pendingConns.get(socketId);
        if (!retry) {
          process.stderr.write(`[node-mitm] no target for socket ${socketId}\n`);
          clientSocket.destroy();
          return;
        }
        pendingConns.delete(socketId);
        doMitm(clientSocket, retry.hostname, retry.port, retry.clientIP, startTime);
      }, 20);
      return;
    }
    pendingConns.delete(socketId);
    doMitm(clientSocket, targetInfo.hostname, targetInfo.port, targetInfo.clientIP, startTime);
  };

  checkAndMitm();
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.send({ type: "ready", port: addr.port });
});

server.on("error", (err) => {
  process.stderr.write(`[node-mitm] server error: ${err.message}\n`);
  process.exit(1);
});

function doMitm(clientSocket, hostname, targetPort, clientIP, startTime) {
  process.stderr.write(`[node-mitm] MITM for ${hostname}:${targetPort} from ${clientIP}\n`);

  const upstream = net.createConnection(targetPort, hostname);

  upstream.on("error", (err) => {
    process.stderr.write(`[node-mitm] upstream error ${hostname}:${targetPort}: ${err.message}\n`);
    clientSocket.destroy();
    upstream.destroy();
  });

  upstream.on("connect", () => {
    const upstreamTls = tls.connect({
      socket: upstream,
      servername: hostname,
      rejectUnauthorized: false,
    });

    upstreamTls.on("error", (err) => {
      process.stderr.write(`[node-mitm] upstream TLS error ${hostname}:${targetPort}: ${err.message}\n`);
      clientSocket.destroy();
      upstreamTls.destroy();
    });

    upstreamTls.on("secure", () => {
      process.stderr.write(`[node-mitm] upstream TLS OK for ${hostname}:${targetPort}\n`);

      const domainCert = certCache.get(hostname) || { cert, key };

      // Use tls.createServer + emit("connection") instead of new TLSSocket
      // because new TLSSocket(socket, {isServer:true}) doesn't work
      const fakeServer = tls.createServer({
        cert: domainCert.cert,
        key: domainCert.key,
      });

      fakeServer.on("error", (err) => {
        process.stderr.write(`[node-mitm] fake server error ${hostname}:${targetPort}: ${err.message}\n`);
        fakeServer.close();
        clientSocket.destroy();
        upstreamTls.destroy();
      });

      fakeServer.on("secureConnection", (clientTls) => {
        process.stderr.write(`[node-mitm] MITM ESTABLISHED ${hostname}:${targetPort}\n`);
        parseHttpTraffic(clientTls, upstreamTls, hostname, targetPort, clientIP, startTime);
      });

      fakeServer.on("tlsClientError", (err) => {
        process.stderr.write(`[node-mitm] TLS client error ${hostname}:${targetPort}: ${err.message}\n`);
        fakeServer.close();
        clientSocket.destroy();
        upstreamTls.destroy();
      });

      // Emit the existing socket into the fake TLS server.
      // The TLS server will wrap the socket and start the handshake.
      // We resume the socket AFTER emit so the TLS server has registered its handlers.
      fakeServer.emit("connection", clientSocket);
      clientSocket.resume();
    });
  });
}

function parseHttpTraffic(clientTls, upstreamTls, hostname, targetPort, clientIP, connectionStartTime) {
  let clientBuf = Buffer.alloc(0);
  let upstreamBuf = Buffer.alloc(0);
  let waitingForResponse = false;
  let destroyed = false;
  let lastReqBody = null;
  let lastRequestData = null;
  let currentReqHeaders = {};
  let currentReqMethod = "";
  let currentReqUrl = "";
  let respHeadersParsed = false;
  let respHeaders = {};
  let respStatusCode = 0;

  clientTls.on("data", (chunk) => {
    clientBuf = Buffer.concat([clientBuf, chunk]);
    processClientBuffer();
  });

  clientTls.on("end", () => { if (!destroyed) finalize("client-end"); });
  clientTls.on("close", () => { if (!destroyed) finalize("client-close"); });
  clientTls.on("error", (err) => { if (!destroyed) finalize("client-error", err.message); });

  upstreamTls.on("data", (chunk) => {
    upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
    processUpstreamBuffer();
  });

  upstreamTls.on("end", () => {
    if (upstreamBuf.length > 0 && respHeadersParsed && waitingForResponse) {
      finishResponse(upstreamBuf);
      upstreamBuf = Buffer.alloc(0);
    }
    if (!destroyed) finalize("upstream-end");
  });
  upstreamTls.on("close", () => { if (!destroyed) finalize("upstream-close"); });
  upstreamTls.on("error", (err) => { if (!destroyed) finalize("upstream-error", err.message); });

  function finalize(label, err) {
    if (destroyed) return;
    destroyed = true;
    const duration = Date.now() - connectionStartTime;
    process.stderr.write(`[node-mitm] ${hostname}:${targetPort} ${label} (${duration}ms)${err ? " err=" + err : ""}\n`);
    try { clientTls.destroy(); } catch (_) {}
    try { upstreamTls.destroy(); } catch (_) {}
  }

  function processClientBuffer() {
    if (destroyed || waitingForResponse) return;

    const headerEnd = clientBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerSection = clientBuf.slice(0, headerEnd).toString();
    clientBuf = clientBuf.slice(headerEnd + 4);

    const lines = headerSection.split("\r\n");
    const requestLine = lines[0] || "";
    const [method, rawPath] = requestLine.split(" ");
    currentReqMethod = method || "";
    currentReqUrl = rawPath || "";

    currentReqHeaders = {};
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx > 0) {
        const k = lines[i].slice(0, colonIdx).trim().toLowerCase();
        const v = lines[i].slice(colonIdx + 1).trim();
        currentReqHeaders[k] = currentReqHeaders[k] ? currentReqHeaders[k] + ", " + v : v;
      }
    }

    const contentLength = parseInt(currentReqHeaders["content-length"] || "0");
    if (contentLength > 0) {
      if (clientBuf.length >= contentLength) {
        const reqBody = clientBuf.slice(0, contentLength);
        clientBuf = clientBuf.slice(contentLength);
        forwardRequest(reqBody);
      }
    } else {
      forwardRequest(null);
    }
  }

  function forwardRequest(reqBody) {
    if (destroyed) return;
    waitingForResponse = true;
    lastReqBody = reqBody;

    let rawReq = `${currentReqMethod} ${currentReqUrl} HTTP/1.1\r\n`;
    const hostHeader = currentReqHeaders["host"] || hostname;
    rawReq += `host: ${hostHeader}\r\n`;
    for (const [k, v] of Object.entries(currentReqHeaders)) {
      if (k === "host" || k === "connection") continue;
      rawReq += `${k}: ${v}\r\n`;
    }
    rawReq += "connection: keep-alive\r\n\r\n";

    const rawReqBuf = Buffer.from(rawReq);
    const totalBuf = reqBody ? Buffer.concat([rawReqBuf, reqBody]) : rawReqBuf;
    upstreamTls.write(totalBuf);

    lastRequestData = {
      method: currentReqMethod,
      url: `https://${hostname}:${targetPort}${currentReqUrl}`,
      host: hostname,
      port: targetPort,
      request_headers: JSON.stringify(currentReqHeaders),
      request_body: reqBody && reqBody.length <= 10 * 1024 * 1024 ? reqBody.toString("base64") : null,
      client_ip: clientIP,
    };
  }

  function processUpstreamBuffer() {
    if (destroyed || !waitingForResponse) return;

    if (!respHeadersParsed) {
      const headerEnd = upstreamBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerSection = upstreamBuf.slice(0, headerEnd).toString();
      upstreamBuf = upstreamBuf.slice(headerEnd + 4);

      const lines = headerSection.split("\r\n");
      const statusLine = lines[0] || "";
      const match = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
      respStatusCode = match ? parseInt(match[1]) : 0;

      respHeaders = {};
      for (let i = 1; i < lines.length; i++) {
        const colonIdx = lines[i].indexOf(":");
        if (colonIdx > 0) {
          const k = lines[i].slice(0, colonIdx).trim().toLowerCase();
          const v = lines[i].slice(colonIdx + 1).trim();
          respHeaders[k] = respHeaders[k] ? respHeaders[k] + ", " + v : v;
        }
      }
      respHeadersParsed = true;
    }

    const contentLength = parseInt(respHeaders["content-length"] || "0");
    const transferEncoding = respHeaders["transfer-encoding"] || "";

    if (transferEncoding.includes("chunked")) {
      const endMarker = upstreamBuf.indexOf(Buffer.from("0\r\n\r\n"));
      if (endMarker !== -1) {
        const rawChunks = upstreamBuf.slice(0, endMarker);
        upstreamBuf = upstreamBuf.slice(endMarker + 5);
        const respBody = decodeChunked(rawChunks);
        finishResponse(respBody);
      }
    } else if (contentLength > 0) {
      if (upstreamBuf.length >= contentLength) {
        const respBody = upstreamBuf.slice(0, contentLength);
        upstreamBuf = upstreamBuf.slice(contentLength);
        finishResponse(respBody);
      }
    } else {
      if (upstreamBuf.length > 0) {
        const respBody = Buffer.from(upstreamBuf);
        upstreamBuf = Buffer.alloc(0);
        finishResponse(respBody);
      }
    }
  }

  function decodeChunked(raw) {
    const parts = [];
    let pos = 0;
    while (pos < raw.length) {
      const lineEnd = raw.indexOf("\r\n", pos);
      if (lineEnd === -1) break;
      const sizeStr = raw.slice(pos, lineEnd).toString().trim();
      const chunkSize = parseInt(sizeStr, 16);
      if (chunkSize === 0) break;
      pos = lineEnd + 2;
      parts.push(raw.slice(pos, pos + chunkSize));
      pos += chunkSize + 2;
    }
    return Buffer.concat(parts);
  }

  function finishResponse(respBody) {
    if (destroyed) return;
    respHeadersParsed = false;

    // Write the HTTP response back to the client over TLS
    const bodyLen = respBody ? respBody.length : 0;
    let rawResp = `HTTP/1.1 ${respStatusCode}\r\n`;
    for (const [k, v] of Object.entries(respHeaders)) {
      if (k === "transfer-encoding") continue;
      rawResp += `${k}: ${v}\r\n`;
    }
    rawResp += `content-length: ${bodyLen}\r\n`;
    rawResp += "connection: keep-alive\r\n\r\n";
    const respBuf = respBody ? Buffer.concat([Buffer.from(rawResp), respBody]) : Buffer.from(rawResp);
    try { clientTls.write(respBuf); } catch (_) {}

    if (lastRequestData) {
      process.send({
        type: "traffic",
        ...lastRequestData,
        status_code: respStatusCode,
        response_headers: JSON.stringify(respHeaders),
        response_body: respBody && respBody.length <= 50 * 1024 * 1024 ? respBody.toString("base64") : null,
        duration_ms: Date.now() - connectionStartTime,
      });
    }

    process.stderr.write(`[node-mitm] ${currentReqMethod} ${lastRequestData?.url || "?"} → ${respStatusCode} (${respBody.length} bytes)\n`);

    waitingForResponse = false;
    lastReqBody = null;
    lastRequestData = null;
    respHeaders = {};
    processClientBuffer();
  }
}
