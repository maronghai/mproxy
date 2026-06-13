import { Database } from "bun:sqlite";

let db: Database;
let insertStmt: ReturnType<Database["prepare"]>;
let listStmt: ReturnType<Database["prepare"]>;
let countStmt: ReturnType<Database["prepare"]>;
let getByIdStmt: ReturnType<Database["prepare"]>;

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

function ensureDB(): Database {
  if (!db) throw new DatabaseError("Database not initialized. Call initDB() first.");
  return db;
}

export function initDB(path = "proxy.db") {
  if (db) {
    try { db.close(); } catch (_) {}
  }
  db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS traffic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      host TEXT,
      port INTEGER,
      request_headers TEXT,
      request_body BLOB,
      status_code INTEGER,
      response_headers TEXT,
      response_body BLOB,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      duration_ms INTEGER,
      client_ip TEXT,
      error TEXT
    )
  `);
  insertStmt = db.prepare(`
    INSERT INTO traffic
      (method, url, host, port, request_headers, request_body,
       status_code, response_headers, response_body, duration_ms, client_ip, error)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  listStmt = db.prepare("SELECT * FROM traffic ORDER BY id DESC LIMIT ? OFFSET ?");
  countStmt = db.prepare("SELECT count(*) as cnt FROM traffic");
  getByIdStmt = db.prepare("SELECT * FROM traffic WHERE id = ?");
  return db;
}

export interface TrafficRecord {
  method: string;
  url: string;
  host: string;
  port: number;
  request_headers: string;
  request_body: Uint8Array | null;
  status_code: number | null;
  response_headers: string | null;
  response_body: Uint8Array | null;
  duration_ms: number | null;
  client_ip: string | null;
  error: string | null;
}

export function insertTraffic(record: TrafficRecord): number {
  ensureDB();
  const reqBody = record.request_body
    ? Buffer.isBuffer(record.request_body) ? record.request_body : Buffer.from(record.request_body)
    : null;
  const respBody = record.response_body
    ? Buffer.isBuffer(record.response_body) ? record.response_body : Buffer.from(record.response_body)
    : null;
  const result = insertStmt.run(
    record.method,
    record.url,
    record.host,
    record.port,
    record.request_headers,
    reqBody,
    record.status_code,
    record.response_headers,
    respBody,
    record.duration_ms,
    record.client_ip,
    record.error,
  );
  return Number(result.lastInsertRowid);
}

export interface TrafficRow {
  id: number;
  method: string;
  url: string;
  host: string;
  port: number;
  request_headers: string;
  request_body: Buffer | null;
  status_code: number | null;
  response_headers: string | null;
  response_body: Buffer | null;
  created_at: string;
  duration_ms: number | null;
  client_ip: string | null;
  error: string | null;
}

export function getTrafficList(limit = 50, offset = 0): TrafficRow[] {
  ensureDB();
  return listStmt.all(limit, offset) as TrafficRow[];
}

export function getTrafficCount(): number {
  ensureDB();
  const row = countStmt.get() as { cnt: number };
  return row.cnt;
}

export function getTrafficById(id: number): TrafficRow | null {
  ensureDB();
  return getByIdStmt.get(id) as TrafficRow | null;
}
