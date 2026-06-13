import "reflect-metadata";
import { initDB } from "./src/db";
import { createProxyServer, createHttpsProxyServer } from "./src/proxy";
import { createViewerServer } from "./src/viewer";
import { CertManager } from "./src/cert";

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "8080") || 8080;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "8443") || 8443;
const VIEWER_PORT = parseInt(process.env.VIEWER_PORT || "3000") || 3000;
const DB_PATH = process.env.DB_PATH || "proxy.db";
const DATA_DIR = process.env.DATA_DIR || ".data";

async function main() {
  console.log("=== Zai Proxy ===\n");

  console.log("Initializing database...");
  initDB(DB_PATH);

  console.log("Initializing certificate authority...");
  const certManager = new CertManager(DATA_DIR);
  await certManager.initCA();
  console.log(`  CA cert: ${certManager.getCACertPath()}`);

  console.log("\nStarting servers...");

  const proxy = createProxyServer(PROXY_PORT);
  console.log(`  HTTP proxy:  http://localhost:${PROXY_PORT}`);

  createHttpsProxyServer(HTTPS_PORT, certManager);

  const viewer = createViewerServer(VIEWER_PORT);
  console.log(`  Web UI:      http://localhost:${VIEWER_PORT}`);

  console.log("\n─── Usage ───");
  console.log(`  HTTP proxy:  curl -x http://localhost:${PROXY_PORT} http://example.com`);
  console.log(`  HTTPS proxy: curl -x http://localhost:${HTTPS_PORT} https://example.com`);
  console.log(`  Browser:     set HTTP proxy to localhost:${PROXY_PORT}`);
  console.log(`               set HTTPS proxy to localhost:${HTTPS_PORT}`);
  console.log(`  Web UI:      open http://localhost:${VIEWER_PORT}`);
  console.log("\n─── HTTPS ───");
  console.log(`  Install CA cert to trust HTTPS traffic:`);
  console.log(`    Windows: certutil -addstore -f "Root" ${certManager.getCACertPath()}`);
  console.log(`    macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certManager.getCACertPath()}`);
  console.log(`    Linux:   sudo cp ${certManager.getCACertPath()} /usr/local/share/ca-certificates/zai-ca.crt && sudo update-ca-certificates`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
