$env:PROXY_PORT="18080"
$env:HTTPS_PORT="18443"
$env:VIEWER_PORT="13000"
$env:DB_PATH="proxy_test.db"

Set-Location "E:\26\6\zai"
Remove-Item -Force -ErrorAction SilentlyContinue proxy_test.db, proxy_test.db-shm, proxy_test.db-wal
& bun run index.ts
