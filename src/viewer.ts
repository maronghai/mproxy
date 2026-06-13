import {
  getTrafficList,
  getTrafficCount,
  getTrafficById,
} from "./db";

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proxy Traffic Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
    .container { max-width: 100%; padding: 16px; }
    h1 { font-size: 1.5em; margin-bottom: 12px; color: #58a6ff; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
    .toolbar button { padding: 6px 14px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .toolbar button:hover { background: #30363d; }
    .toolbar button.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
    .toolbar span { color: #8b949e; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #21262d; }
    th { background: #161b22; color: #8b949e; font-weight: 600; position: sticky; top: 0; }
    .traffic-row { cursor: pointer; transition: background 0.1s; }
    .traffic-row:hover { background: #161b22; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; color: #8b949e; }
    .method { font-weight: 600; color: #d2a8ff; }
    .url { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #58a6ff; }
    .status { font-weight: 600; font-family: monospace; }
    .success { color: #3fb950; }
    .redirect { color: #d29922; }
    .client-error { color: #d29922; }
    .server-error { color: #f85149; }
    .error { color: #f85149; }
    .time { color: #8b949e; white-space: nowrap; }
    .detail-panel { position: fixed; top: 0; right: 0; width: 50vw; height: 100vh; background: #161b22; border-left: 1px solid #30363d; overflow-y: auto; padding: 20px; z-index: 100; display: none; }
    .detail-panel.open { display: block; }
    .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .detail-header h3 { font-size: 1.1em; color: #58a6ff; word-break: break-all; }
    .detail-header button { padding: 4px 12px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; border-radius: 6px; cursor: pointer; }
    .detail-meta { display: flex; gap: 16px; margin-bottom: 16px; font-size: 13px; color: #8b949e; }
    .detail-section { margin-bottom: 16px; }
    .detail-section h4 { font-size: 0.9em; color: #8b949e; margin-bottom: 6px; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
    pre { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
    .error-box { background: #49020280; border: 1px solid #f8514940; color: #f85149; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
    .overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 99; display: none; }
    .overlay.open { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Proxy Traffic Viewer</h1>
    <div class="toolbar">
      <button onclick="refresh()" id="refreshBtn">Refresh</button>
      <button onclick="prevPage()" id="prevBtn">← Prev</button>
      <button onclick="nextPage()" id="nextBtn">Next →</button>
      <span id="countInfo">Loading...</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Method</th>
          <th>URL</th>
          <th>Status</th>
          <th>Time</th>
          <th>Req Size</th>
          <th>Resp Size</th>
          <th>Client</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody id="trafficList"></tbody>
    </table>
  </div>

  <div class="overlay" id="overlay" onclick="closeDetail()"></div>
  <div class="detail-panel" id="detailPanel"></div>

  <script>
    let currentPage = 0;
    const pageSize = 50;

    function prevPage() {
      if (currentPage > 0) {
        currentPage--;
        refresh();
      }
    }

    function nextPage() {
      currentPage++;
      refresh();
    }

    async function refresh() {
      try {
        const resp = await fetch('/api/list?limit=' + pageSize + '&offset=' + (currentPage * pageSize));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const tbody = document.getElementById('trafficList');
        tbody.innerHTML = data.rows.map(row => renderRow(row)).join('');
        const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
        if (currentPage >= totalPages) currentPage = totalPages - 1;
        if (currentPage < 0) currentPage = 0;
        document.getElementById('countInfo').textContent =
          'Total: ' + data.total + ' | Page ' + (currentPage + 1) + '/' + totalPages + ' | Showing ' + data.rows.length + ' records';
        document.getElementById('prevBtn').disabled = currentPage === 0;
        document.getElementById('nextBtn').disabled = currentPage >= totalPages - 1;
      } catch (e) {
        document.getElementById('countInfo').textContent = 'Error loading data';
      }
    }

    function renderRow(row) {
      const statusClass =
        !row.status_code ? 'error' :
        row.status_code < 300 ? 'success' :
        row.status_code < 400 ? 'redirect' :
        row.status_code < 500 ? 'client-error' : 'server-error';

      return '<tr class="traffic-row" onclick="showDetail(' + row.id + ')">' +
        '<td class="mono">' + row.id + '</td>' +
        '<td class="method">' + esc(row.method) + '</td>' +
        '<td class="url" title="' + esc(row.url) + '">' + esc(row.url) + '</td>' +
        '<td class="status ' + statusClass + '">' + (row.status_code || 'ERR') + '</td>' +
        '<td>' + (row.duration_ms !== null ? row.duration_ms + 'ms' : '-') + '</td>' +
        '<td>' + formatBytes(row.request_body_size || 0) + '</td>' +
        '<td>' + formatBytes(row.response_body_size || 0) + '</td>' +
        '<td>' + esc(row.client_ip || '') + '</td>' +
        '<td class="time">' + esc(row.created_at || '') + '</td>' +
        '</tr>';
    }

    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function formatBytes(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
      return (b/(1024*1024)).toFixed(1) + ' MB';
    }

    async function showDetail(id) {
      try {
        const resp = await fetch('/api/detail/' + id);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();

        let reqHeaders = '';
        try { reqHeaders = JSON.stringify(JSON.parse(data.request_headers), null, 2); } catch { reqHeaders = data.request_headers || ''; }
        let respHeaders = '';
        if (data.response_headers) { try { respHeaders = JSON.stringify(JSON.parse(data.response_headers), null, 2); } catch { respHeaders = data.response_headers; } }

        const html = '<div class="detail-header">' +
          '<h3>#' + data.id + ' ' + esc(data.method) + ' ' + esc(data.url) + '</h3>' +
          '<button onclick="closeDetail()">Close</button></div>' +
          '<div class="detail-meta">' +
          '<span>Status: <b class="status ' + (data.status_code && data.status_code < 400 ? 'success' : 'error') + '">' + (data.status_code || 'N/A') + '</b></span>' +
          '<span>Duration: ' + (data.duration_ms !== null ? data.duration_ms + 'ms' : '-') + '</span>' +
          '<span>Client: ' + esc(data.client_ip || '') + '</span>' +
          '<span>Time: ' + esc(data.created_at || '') + '</span></div>' +
          (data.error ? '<div class="error-box">Error: ' + esc(data.error) + '</div>' : '') +
          '<div class="detail-section"><h4>Request Headers</h4><pre class="headers">' + esc(reqHeaders) + '</pre></div>' +
          '<div class="detail-section"><h4>Request Body</h4><pre class="body">' + esc(data.request_body || '') + '</pre></div>' +
          '<div class="detail-section"><h4>Response Headers</h4><pre class="headers">' + esc(respHeaders) + '</pre></div>' +
          '<div class="detail-section"><h4>Response Body</h4><pre class="body">' + esc(data.response_body || '') + '</pre></div>';

        document.getElementById('detailPanel').innerHTML = html;
        document.getElementById('detailPanel').classList.add('open');
        document.getElementById('overlay').classList.add('open');
      } catch (e) {
        alert('Failed to load detail');
      }
    }

    function closeDetail() {
      document.getElementById('detailPanel').classList.remove('open');
      document.getElementById('overlay').classList.remove('open');
    }

    refresh();
    // Auto-refresh every 3 seconds
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;

export function createViewerServer(port: number) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: async (req) => {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // API endpoints
      if (url.pathname === "/api/list") {
        const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "50") || 50));
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0") || 0);
        const rows = getTrafficList(limit, offset);
        const total = getTrafficCount();
        // Add body size info without sending full body
        const rowsWithSize = rows.map((r) => ({
          ...r,
          request_body: undefined,
          response_body: undefined,
          request_body_size: r.request_body ? r.request_body.length : 0,
          response_body_size: r.response_body ? r.response_body.length : 0,
        }));
        return Response.json({ rows: rowsWithSize, total }, { headers: corsHeaders });
      }

      if (url.pathname.startsWith("/api/detail/")) {
        const idStr = url.pathname.split("/")[3] || "";
        const id = parseInt(idStr);
        if (isNaN(id) || id <= 0) {
          return Response.json({ error: "Invalid ID" }, { status: 400, headers: corsHeaders });
        }
        const row = getTrafficById(id);
        if (!row) {
          return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
        }
        // Decode bodies to text for display
        const detail = {
          ...row,
          request_body: row.request_body
            ? new TextDecoder().decode(row.request_body).slice(0, 100000)
            : null,
          response_body: row.response_body
            ? new TextDecoder().decode(row.response_body).slice(0, 100000)
            : null,
        };
        return Response.json(detail, { headers: corsHeaders });
      }

      if (url.pathname === "/api/stats") {
        const total = getTrafficCount();
        return Response.json({ total }, { headers: corsHeaders });
      }

      // Viewer HTML page
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML_TEMPLATE, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    },
  });
}
