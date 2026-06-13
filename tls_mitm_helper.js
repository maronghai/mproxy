// tls_mitm_helper.js - Node.js subprocess for TLS MITM
// Reads cert/key from stdin, listens on a port, performs TLS MITM,
// then pipes decrypted HTTP traffic to/from the parent process.

const net = require("net");
const tls = require("tls");
const { readFileSync } = require("fs");

let config = null;
let certReady = false;

// Read config from stdin
process.stdin.setEncoding("utf-8");
let stdinBuf = "";
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  // Try to parse JSON config
  const nlIdx = stdinBuf.indexOf("\n");
  if (nlIdx !== -1 && !config) {
    const line = stdinBuf.slice(0, nlIdx).trim();
    stdinBuf = stdinBuf.slice(nlIdx + 1);
    try {
      config = JSON.parse(line);
      startServer();
    } catch (e) {
      process.stderr.write(`[helper] config parse error: ${e.message}\n`);
      process.exit(1);
    }
  }
});

process.stdin.on("end", () => {
  if (!config) {
    process.stderr.write("[helper] stdin closed without config\n");
    process.exit(1);
  }
});

function startServer() {
  const { cert, key, targetHost, targetPort, clientPort } = config;

  // Create a local TCP server that the client socket will be piped to
  const server = net.createServer((clientSide) => {
    process.stderr.write(`[helper] client connected on local port\n`);

    // Connect to upstream
    const upstream = net.createConnection(targetPort, targetHost);

    upstream.on("error", (err) => {
      process.stderr.write(`[helper] upstream error: ${err.message}\n`);
      clientSide.destroy();
      upstream.destroy();
    });

    upstream.on("connect", () => {
      process.stderr.write(`[helper] upstream connected to ${targetHost}:${targetPort}\n`);

      // Wrap upstream as TLS client
      const upstreamTls = tls.connect({
        socket: upstream,
        servername: targetHost,
        rejectUnauthorized: false,
      });

      upstreamTls.on("error", (err) => {
        process.stderr.write(`[helper] upstream TLS error: ${err.message}\n`);
        clientSide.destroy();
        upstreamTls.destroy();
      });

      upstreamTls.on("secure", () => {
        process.stderr.write(`[helper] upstream TLS established\n`);

        // Wrap clientSide as TLS server
        const clientTls = new tls.TLSSocket(clientSide, {
          isServer: true,
          cert: cert,
          key: key,
        });

        clientTls.on("error", (err) => {
          process.stderr.write(`[helper] client TLS error: ${err.message}\n`);
          clientTls.destroy();
          upstreamTls.destroy();
        });

        clientTls.on("secure", () => {
          process.stderr.write(`[helper] client TLS established\n`);

          // Now we have decrypted traffic on both sides
          // Parse HTTP requests from client, forward to upstream, capture responses

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

          clientTls.on("end", () => { if (!destroyed) { destroyed = true; cleanup(); } });
          upstreamTls.on("end", () => {
            if (upstreamBuf.length > 0 && waitingForResponse) {
              finishResponse(upstreamBuf);
            }
            if (!destroyed) { destroyed = true; cleanup(); }
          });

          function cleanup() {
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

            // Send request to upstream
            let rawReq = `${method} ${rawPath} HTTP/1.1\r\n`;
            const hostHeader = headers["host"] || targetHost;
            rawReq += `host: ${hostHeader}\r\n`;
            for (const [k, v] of Object.entries(headers)) {
              if (k === "host" || k === "connection") continue;
              rawReq += `${k}: ${v}\r\n`;
            }
            rawReq += "connection: keep-alive\r\n\r\n";

            const rawReqBuf = Buffer.from(rawReq);
            const totalBuf = reqBody ? Buffer.concat([rawReqBuf, reqBody]) : rawReqBuf;
            upstreamTls.write(totalBuf);

            // Write record to stdout for parent process
            const record = {
              type: "request",
              method,
              url: `https://${targetHost}:${targetPort}${rawPath}`,
              host: targetHost,
              port: targetPort,
              headers: JSON.stringify(headers),
              body: reqBody ? reqBody.toString("base64") : null,
            };
            process.stdout.write(JSON.stringify(record) + "\n");
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
              // No content-length: read until close (for keep-alive this shouldn't happen)
              if (upstreamBuf.length > 0) {
                const respBody = Buffer.from(upstreamBuf);
                upstreamBuf = Buffer.alloc(0);
                finishResponse(respBody, statusCode, respHeaders);
              }
            }
          }

          function finishResponse(respBody, statusCode, respHeaders) {
            waitingForResponse = false;

            const record = {
              type: "response",
              status_code: statusCode,
              headers: JSON.stringify(respHeaders),
              body: respBody ? respBody.toString("base64") : null,
            };
            process.stdout.write(JSON.stringify(record) + "\n");

            // Continue processing next request
            processClientBuffer();
          }
        });
      });
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    // Tell parent the port we're listening on
    process.stdout.write(JSON.stringify({ type: "ready", port: addr.port }) + "\n");
  });

  server.on("error", (err) => {
    process.stderr.write(`[helper] server error: ${err.message}\n`);
    process.exit(1);
  });
}

// Timeout after 60 seconds of no activity
setTimeout(() => {
  process.stderr.write("[helper] timeout\n");
  process.exit(1);
}, 60000);
