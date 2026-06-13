// tls_mitm.js - Node.js subprocess for HTTPS MITM
// Receives cert/key via IPC, listens on a local port.
// Bun pipes client data to this port after CONNECT.
// This script performs TLS MITM and reports traffic back via IPC.

const net = require("net");
const tls = require("tls");
const { join } = require("path");

let config = null;

process.on("message", (msg) => {
  if (msg.type === "config") {
    config = msg;
    startServer();
  }
});

process.on("error", (err) => {
  process.stderr.write(`[mitm] process error: ${err.message}\n`);
});

function startServer() {
  const { cert, key, targetHost, targetPort, requestId } = config;

  const server = net.createServer((clientSide) => {
    process.stderr.write(`[mitm] client connected to local port\n`);

    // Connect to upstream
    const upstream = net.createConnection(targetPort, targetHost);

    upstream.on("error", (err) => {
      process.stderr.write(`[mitm] upstream error: ${err.message}\n`);
      cleanup();
    });

    upstream.on("connect", () => {
      process.stderr.write(`[mitm] upstream connected to ${targetHost}:${targetPort}\n`);

      // Wrap upstream as TLS client
      const upstreamTls = tls.connect({
        socket: upstream,
        servername: targetHost,
        rejectUnauthorized: false,
      });

      upstreamTls.on("error", (err) => {
        process.stderr.write(`[mitm] upstream TLS error: ${err.message}\n`);
        cleanup();
      });

      upstreamTls.on("secure", () => {
        process.stderr.write(`[mitm] upstream TLS established\n`);

        // Wrap clientSide as TLS server
        const clientTls = new tls.TLSSocket(clientSide, {
          isServer: true,
          cert,
          key,
        });

        clientTls.on("error", (err) => {
          process.stderr.write(`[mitm] client TLS error: ${err.message}\n`);
          cleanup();
        });

        clientTls.on("secure", () => {
          process.stderr.write(`[mitm] CLIENT TLS ESTABLISHED for ${targetHost}:${targetPort}\n`);
          handleMitm(clientTls, upstreamTls);
        });
      });
    });

    function cleanup() {
      try { clientSide.destroy(); } catch (_) {}
      try { upstream.destroy(); } catch (_) {}
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    process.send({ type: "ready", port: addr.port, requestId });
    process.stderr.write(`[mitm] listening on 127.0.0.1:${addr.port}\n`);
  });

  server.on("error", (err) => {
    process.stderr.write(`[mitm] server error: ${err.message}\n`);
    process.exit(1);
  });
}

function handleMitm(clientTls, upstreamTls) {
  let clientBuf = Buffer.alloc(0);
  let upstreamBuf = Buffer.alloc(0);
  let waitingForResponse = false;
  let destroyed = false;

  clientTls.on("data", (chunk) => {
    clientBuf = Buffer.concat([clientBuf, chunk]);
    processClientBuffer();
  });

  upstreamTls.on("data", (chunk) => {
    upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
    processUpstreamBuffer();
  });

  clientTls.on("end", () => { if (!destroyed) { destroyed = true; } });
  upstreamTls.on("end", () => {
    if (upstreamBuf.length > 0 && waitingForResponse) {
      finishResponse(upstreamBuf);
    }
    if (!destroyed) { destroyed = true; }
    process.exit(0);
  });

  function processClientBuffer() {
    if (destroyed || waitingForResponse) return;
    const headerEnd = clientBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerSection = clientBuf.slice(0, headerEnd).toString();
    clientBuf = clientBuf.slice(headerEnd + 4);

    const lines = headerSection.split("\r\n");
    const requestLine = lines[0] || "";
    const [method, rawPath] = requestLine.split(" ");

    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx > 0) {
        const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
        const value = lines[i].slice(colonIdx + 1).trim();
        headers[key] = headers[key] ? headers[key] + ", " + value : value;
      }
    }

    const contentLength = parseInt(headers["content-length"] || "0");
    let reqBody = null;

    if (contentLength > 0 && clientBuf.length >= contentLength) {
      reqBody = clientBuf.slice(0, contentLength);
      clientBuf = clientBuf.slice(contentLength);
    } else if (contentLength > 0) {
      return; // Wait for more data
    }

    waitingForResponse = true;

    // Send to upstream
    let rawReq = `${method} ${rawPath} HTTP/1.1\r\n`;
    const hostHeader = headers["host"] || config.targetHost;
    rawReq += `host: ${hostHeader}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (k === "host" || k === "connection") continue;
      rawReq += `${k}: ${v}\r\n`;
    }
    rawReq += "connection: keep-alive\r\n\r\n";

    const rawReqBuf = Buffer.from(rawReq);
    const totalBuf = reqBody ? Buffer.concat([rawReqBuf, reqBody]) : rawReqBuf;
    upstreamTls.write(totalBuf);

    // Report request to parent
    process.send({
      type: "request",
      method,
      url: `https://${config.targetHost}:${config.targetPort}${rawPath}`,
      host: config.targetHost,
      port: config.targetPort,
      headers: JSON.stringify(headers),
      body: reqBody ? reqBody.toString("base64") : null,
    });
  }

  function processUpstreamBuffer() {
    if (destroyed || !waitingForResponse) return;
    const headerEnd = upstreamBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerSection = upstreamBuf.slice(0, headerEnd).toString();
    upstreamBuf = upstreamBuf.slice(headerEnd + 4);

    const lines = headerSection.split("\r\n");
    const statusLine = lines[0] || "";
    const match = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
    const statusCode = match ? parseInt(match[1]) : 0;

    const respHeaders = {};
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx > 0) {
        const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
        const value = lines[i].slice(colonIdx + 1).trim();
        respHeaders[key] = respHeaders[key] ? respHeaders[key] + ", " + value : value;
      }
    }

    const contentLength = parseInt(respHeaders["content-length"] || "0");
    const transferEncoding = respHeaders["transfer-encoding"] || "";

    if (transferEncoding.includes("chunked")) {
      const endMarker = upstreamBuf.indexOf(Buffer.from("0\r\n\r\n"));
      if (endMarker !== -1) {
        const respBody = upstreamBuf.slice(0, endMarker);
        upstreamBuf = upstreamBuf.slice(endMarker + 5);
        finishResponse(respBody, statusCode, respHeaders);
      }
    } else if (contentLength > 0) {
      if (upstreamBuf.length >= contentLength) {
        const respBody = upstreamBuf.slice(0, contentLength);
        upstreamBuf = upstreamBuf.slice(contentLength);
        finishResponse(respBody, statusCode, respHeaders);
      }
    } else {
      if (upstreamBuf.length > 0) {
        const respBody = Buffer.from(upstreamBuf);
        upstreamBuf = Buffer.alloc(0);
        finishResponse(respBody, statusCode, respHeaders);
      }
    }
  }

  function finishResponse(respBody, statusCode, respHeaders) {
    waitingForResponse = false;

    process.send({
      type: "response",
      status_code: statusCode,
      headers: JSON.stringify(respHeaders),
      body: respBody ? respBody.toString("base64") : null,
    });

    processClientBuffer();
  }
}
