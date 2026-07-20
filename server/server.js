// server.js — OneSVD hub
//   :4000  TLS  (public)    wss://api.onesvd.com:4000   WebSocket  (browsers, tree stream)
//                           https://api.onesvd.com:4000 POST /upload  (file upload)
//                           https://api.onesvd.com:4000 POST /delete  (delete file/folder)
//                           https://api.onesvd.com:4000 GET  /zip     (download folder as zip)
//   :4001  plain HTTP       http://127.0.0.1:4001/ingest  (Go watcher, loopback only)
//
// Go is the source of truth. This hub holds a MIRROR tree built only from Go's
// snapshot+patches and fans it out — it never hashes anything itself. Uploads
// and deletes just change ROOT on disk; the watcher notices and a patch flows out.

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const WebSocket = require("ws");
const Busboy = require("busboy");
const { spawn, spawnSync } = require("child_process");

// Load a .env sitting next to this file (so it works no matter how the process
// is launched — bare node, pm2, systemd — without needing --env-file). Existing
// environment variables always win; only fills in ones that aren't already set.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (let line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.warn("could not read .env:", e.message);
  }
})();

// ── configuration (env-driven, localhost-friendly defaults) ──────────────────
// All deployment-specific values come from the environment so the same binary
// runs locally over HTTP or in production over TLS. The launch script sets
// these per profile; unset means the localhost defaults below.
const WSS_PORT = parseInt(process.env.ONESVD_HUB_PORT || "4000", 10);     // public WS + HTTP(S)
const INGEST_PORT = parseInt(process.env.ONESVD_INGEST_PORT || "4001", 10); // loopback Go ingest
// watched root: where files land. Defaults to ./onesvd-root beside the process.
const ROOT = path.resolve(process.env.ONESVD_ROOT || path.join(process.cwd(), "onesvd-root"));

// TLS: provide BOTH cert paths to enable HTTPS/WSS. If either is missing the hub
// serves plain HTTP/ws (the localhost profile). No domain/cert needed locally.
const TLS_KEY = process.env.ONESVD_TLS_KEY || "";
const TLS_CERT = process.env.ONESVD_TLS_CERT || "";
const TLS_ON = !!(TLS_KEY && TLS_CERT && fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT));
// public-facing host used only to build absolute redirect URLs (login). In
// HTTP/localhost mode this is derived from the request instead.
const PUBLIC_HOST = process.env.ONESVD_PUBLIC_HOST || ""; // e.g. api.onesvd.com (prod)

// ── storage / quota ──────────────────────────────────────────────────────────
// Reports usable space for the bottom-left UI readout. "total" is the physical
// filesystem size today; in the cloud version set ONESVD_QUOTA_BYTES to a plan
// limit and that becomes the cap instead (free = quota - used).
const QUOTA_BYTES = (() => {
  const v = parseInt(process.env.ONESVD_QUOTA_BYTES || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 0; // 0 = use physical disk size
})();
let _diskCache = null;
let _diskAt = 0;
function diskInfo() {
  const now = Date.now();
  if (_diskCache && now - _diskAt < 4000) return _diskCache; // cheap, but cache anyway
  let info = null;
  try {
    const s = fs.statfsSync(ROOT);
    const diskTotal = s.blocks * s.bsize;   // physical size of the filesystem
    const diskFree = s.bavail * s.bsize;    // available to a normal user (df "Avail")
    const used = diskTotal - diskFree;      // bytes consumed on the filesystem
    if (QUOTA_BYTES > 0) {
      // plan-limited: cap total at the quota, free is whatever's left under it
      const total = QUOTA_BYTES;
      const free = Math.max(0, total - used);
      info = { total, free, used, quota: true };
    } else {
      info = { total: diskTotal, free: diskFree, used, quota: false };
    }
  } catch {
    info = null; // statfs unsupported / path gone — UI hides the bar
  }
  _diskCache = info;
  _diskAt = now;
  return info;
}

// ── auth ─────────────────────────────────────────────────────────────────────
// ONESVD_TOKEN   : bearer token required on write endpoints (empty = no token)
// ONESVD_ALLOW_IPS : comma-separated allowlist gating ALL hub access (empty = any)
const crypto = require("crypto");
const AUTH_TOKEN = process.env.ONESVD_TOKEN || "";
const ALLOW_IPS = (process.env.ONESVD_ALLOW_IPS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// trustworthy client IP: the raw socket address (X-Forwarded-For is spoofable
// and the hub's endpoints are hit directly, not via nginx)
function socketIp(req) {
  const ip = (req.socket && req.socket.remoteAddress) || "";
  return ip.replace(/^::ffff:/, ""); // unwrap IPv4-mapped IPv6
}
function ipAllowed(ip) {
  if (ALLOW_IPS.length === 0) return true;          // allowlist not configured
  if (ip === "127.0.0.1" || ip === "::1") return true; // always allow loopback
  return ALLOW_IPS.includes(ip);
}
function tokenOk(req) {
  if (!AUTH_TOKEN) return true; // token not configured
  // accept "Authorization: Bearer X" (fetch/XHR) or "?token=X" (WS / downloads)
  let provided = "";
  const m = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] || "");
  if (m) provided = m[1];
  else {
    try { provided = new URL(req.url, "https://x").searchParams.get("token") || ""; } catch {}
  }
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── sessions ─────────────────────────────────────────────────────────────────
// A session lets a browser carry auth in an HttpOnly cookie instead of a token
// in the URL — so shareable links (CSV, file URLs) never leak the token. The
// user exchanges the token for a session cookie once (the app does this on token
// entry); after that, file/zip navigations are authorized by the cookie alone.
const SESSION_COOKIE = "onesvd_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSIONS_FILE = path.join(__dirname, "sessions.json"); // outside ROOT
const sessions = new Map(); // id -> { created }

function loadSessions() {
  try {
    const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const now = Date.now();
    let live = 0;
    for (const s of arr) {
      if (s && s.id && typeof s.created === "number" && now - s.created <= SESSION_TTL_MS) {
        sessions.set(s.id, { created: s.created });
        live++;
      }
    }
    console.log(`sessions: loaded ${live}`);
  } catch { /* no file yet */ }
}
function saveSessions() {
  try {
    const arr = [];
    for (const [id, s] of sessions) arr.push({ id, created: s.created });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr));
  } catch (e) {
    console.error("saveSessions:", e);
  }
}

function newSession() {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { created: Date.now() });
  saveSessions();
  return id;
}
function sessionValid(id) {
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  if (Date.now() - s.created > SESSION_TTL_MS) { sessions.delete(id); return false; }
  return true;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers["cookie"];
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookieOk(req) {
  return sessionValid(parseCookies(req)[SESSION_COOKIE]);
}
// authorized if EITHER a valid token (header/query) OR a valid session cookie.
function requestAuthed(req) {
  if (!AUTH_TOKEN) return true;
  return tokenOk(req) || sessionCookieOk(req);
}
// treat as a browser navigation (vs API/curl) so we can redirect to login
function isNavigation(req) {
  if ((req.headers["sec-fetch-mode"] || "") === "navigate") return true;
  return /text\/html/i.test(req.headers["accept"] || "");
}
function sessionCookieHeader(id) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // SameSite=Lax so top-level navigations to file links carry it; HttpOnly so JS
  // can't read it. Secure only under TLS (a Secure cookie is dropped over plain
  // HTTP, which would break sessions in the localhost profile).
  const secure = TLS_ON ? " Secure;" : "";
  return `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly;${secure} SameSite=Lax`;
}

// Zip backend detection. Prefer the `archiver` npm package if it's installed
// AND callable; otherwise fall back to the system `zip` binary. If neither is
// available, /zip returns 503 instead of crashing the process.
let archiverFn = null;
try {
  const a = require("archiver");
  if (typeof a === "function") archiverFn = a;
  else console.warn("archiver loaded but is not a function; falling back to system zip");
} catch {
  /* archiver not installed */
}
let hasSystemZip = false;
try {
  hasSystemZip = !spawnSync("zip", ["-v"], { stdio: "ignore" }).error;
} catch {
  hasSystemZip = false;
}
const ZIP_OK = !!archiverFn || hasSystemZip;
console.log(
  `zip backend: ${archiverFn ? "archiver" : hasSystemZip ? "system zip" : "NONE (/zip disabled)"}`
);

// git availability — needed for the /git runner (clone + build + copy artifacts)
let hasGit = false;
try {
  hasGit = !spawnSync("git", ["--version"], { stdio: "ignore" }).error;
} catch {
  hasGit = false;
}
console.log(`git runner: ${hasGit ? "enabled" : "NONE (/git disabled)"}`);

let version = 0;
let tree = null; // mirror root

// Persist the mirror tree so a hub restart can serve the LAST KNOWN tree to
// browsers immediately, instead of showing nothing until the next file change
// makes the Go watcher resync. The watcher remains the source of truth: when it
// next sends a snapshot or an in-sequence patch, this is overwritten/updated.
const TREE_FILE = path.join(__dirname, "tree.json"); // outside ROOT
// identity of the vault this tree describes. A reinstall pointed at a NEW path
// must not serve the OLD path's persisted tree as truth — the id makes stale
// state self-invalidating, here and in the client's cache.
const ROOT_ID = crypto.createHash("sha256").update(ROOT).digest("hex").slice(0, 16);
let treeSaveTimer = null;
function loadTree() {
  try {
    const saved = JSON.parse(fs.readFileSync(TREE_FILE, "utf8"));
    if (saved && saved.tree && saved.rootId !== ROOT_ID) {
      console.log("tree: discarding persisted tree — it describes a different root");
    } else if (saved && saved.tree) {
      tree = saved.tree;
      version = typeof saved.version === "number" ? saved.version : 0;
      console.log(`tree: loaded last-known (version ${version})`);
    }
  } catch { /* no file yet */ }
}
function saveTreeNow() {
  try {
    if (tree) fs.writeFileSync(TREE_FILE, JSON.stringify({ version, tree, rootId: ROOT_ID }));
  } catch (e) {
    console.error("saveTree:", e);
  }
}
// Async variant for the steady-state path: the synchronous write was blocking
// the event loop (which also serves upload chunks) for the entire disk write of
// a multi-MB tree JSON. Only shutdown uses the sync version now. The stringify
// itself still costs CPU on the loop — brief — but the disk I/O no longer stalls
// everything. An in-flight guard coalesces bursts instead of overlapping writes.
let treeSaving = false, treeSaveAgain = false;
function saveTreeAsync() {
  if (!tree) return;
  if (treeSaving) { treeSaveAgain = true; return; }
  treeSaving = true;
  const body = JSON.stringify({ version, tree, rootId: ROOT_ID });
  fs.writeFile(TREE_FILE, body, (e) => {
    treeSaving = false;
    if (e) console.error("saveTree:", e);
    if (treeSaveAgain) { treeSaveAgain = false; saveTreeSoon(); }
  });
}
// debounce disk writes — patches can arrive in bursts
function saveTreeSoon() {
  if (treeSaveTimer) return;
  treeSaveTimer = setTimeout(() => { treeSaveTimer = null; saveTreeAsync(); }, 5000);
}

// ── mirror tree mutation (same shape the browser applies) ────────────────────

function applyChange(root, c) {
  if (!root) return;
  if (c.path === ".") {
    // root recompute — update the root node's hash so late joiners see it
    if (c.sha256) root.sha256 = c.sha256;
    return;
  }
  const parts = c.path.split("/");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node.children) return;
    const next = node.children.find((x) => x.name === parts[i]);
    if (!next) return;
    node = next;
  }
  const name = parts[parts.length - 1];
  if (!node.children) node.children = [];
  const idx = node.children.findIndex((x) => x.name === name);

  if (c.op === "delete") {
    if (idx !== -1) node.children.splice(idx, 1);
    return;
  }
  const existing = idx !== -1 ? node.children[idx] : null;
  const updated = {
    name,
    path: c.path,
    type: c.type || "file",
    sha256: c.sha256 || "",
    size: c.size,
    mtime: c.mtime,
    children: existing ? existing.children : c.type === "directory" ? [] : undefined,
  };
  if (idx !== -1) node.children[idx] = updated;
  else node.children.push(updated);
  // match the worker's hashing order exactly: ascending child hash, name tiebreak
  node.children.sort((a, b) => {
    const ah = a.sha256 || "", bh = b.sha256 || "";
    if (ah !== bh) return ah < bh ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

let watcherStatus = { state: "starting", detail: "", at: 0 };

function handleIngest(msg) {
  if (msg.kind === "lane") {
    // per-lane "currently hashing" — transient relay like hashprog
    broadcast({ kind: "lane", lane: String(msg.lane || ""), path: String(msg.path || "") });
    return;
  }
  if (msg.kind === "hashprog") {
    // transient per-file hashing progress — relay only, nothing to remember
    broadcast({ kind: "hashprog", path: String(msg.path || ""), done: Number(msg.done) || 0, size: Number(msg.size) || 0 });
    return;
  }
  if (msg.kind === "status") {
    // watcher telemetry: what the daemon is actively doing (scanning/hashing/
    // reconciling/idle). Remember it for new connections and relay to everyone.
    watcherStatus = { state: String(msg.state || "idle"), detail: String(msg.detail || ""), at: Date.now() };
    broadcast({ kind: "watcher", ...watcherStatus });
    return;
  }
  if (msg.kind === "recalc") {
    // informational hint: which paths are about to be rehashed. Relay as-is,
    // no tree mutation, no version change.
    broadcast({ kind: "recalc", paths: msg.paths || [] });
    return;
  }
  if (msg.kind === "snapshot") {
    tree = msg.tree;
    version = msg.version;
    broadcast({ kind: "snapshot", version, tree });
    hubEvent("info", `watcher resync · snapshot v${version}`);
    saveTreeSoon();
  } else if (msg.kind === "patch") {
    if (msg.version !== version + 1) return; // gap/stale -> Go resyncs from our response
    for (const c of msg.changes || []) applyChange(tree, c);
    version = msg.version;
    broadcast({ kind: "patch", version, changes: msg.changes });
    saveTreeSoon();
  }
}

// ── upload handler ───────────────────────────────────────────────────────────

function handleUpload(req, res) {
  // optional subfolder via ?dir=sub/path — must resolve inside ROOT
  const url = new URL(req.url, "http://localhost");
  const sub = url.searchParams.get("dir") || "";
  const destDir = path.resolve(ROOT, sub);
  if (destDir !== ROOT && !destDir.startsWith(ROOT + path.sep)) {
    res.writeHead(400);
    return res.end("invalid dir");
  }
  // create the target dir (and any parents) so nested folder uploads work
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    res.writeHead(500);
    return res.end("mkdir failed: " + e.message);
  }

  let bb;
  try {
    bb = Busboy({ headers: req.headers });
  } catch {
    res.writeHead(400);
    return res.end("expected multipart/form-data");
  }

  let count = 0;
  let failed = false;
  const pending = [];

  bb.on("file", (_field, file, info) => {
    const safe = path.basename(info.filename || "upload"); // strip path components
    const dest = path.join(destDir, safe);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true }); // ensure parent exists
    } catch (e) {
      failed = true;
      console.error("mkdir error:", e);
      file.resume(); // drain so busboy can move on
      return;
    }
    const out = fs.createWriteStream(dest);
    pending.push(
      new Promise((resolve) => {
        out.on("finish", () => { count++; resolve(); });
        out.on("error", (e) => { failed = true; console.error("write error:", e); resolve(); });
      })
    );
    file.pipe(out);
  });

  bb.on("close", async () => {
    await Promise.all(pending);
    if (failed) { res.writeHead(500); return res.end("write failed"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count }));
  });
  bb.on("error", (e) => { res.writeHead(400); res.end(String(e)); });

  req.pipe(bb);
}

// ── resumable chunked upload ─────────────────────────────────────────────────
// POST /upload/init    {key,name,size,dir} -> {id, received}
// POST /upload/chunk?id=&offset=  (raw body) -> {received}   (409 {received} to resync)
// GET  /upload/status?id=  -> {received, size, name, dir}
// POST /upload/finish?id=  {expectedSha?} -> {ok, sha256, size}
// Partial files live OUTSIDE ROOT so half-uploads don't enter the tree.

const TMP = path.join(__dirname, "uploads-tmp");
try { fs.mkdirSync(TMP, { recursive: true }); } catch {}
const partPath = (id) => path.join(TMP, id + ".part");
const metaPath = (id) => path.join(TMP, id + ".json");
function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")); } catch { return null; }
}
function writeMeta(id, m) {
  try { fs.writeFileSync(metaPath(id), JSON.stringify(m)); } catch (e) { console.error("meta write:", e); }
}
function readJsonBody(req, res, cb) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => { try { cb(JSON.parse(body || "{}")); } catch { res.writeHead(400); res.end("bad json"); } });
}
function sweepTemps() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(TMP)) {
      const p = path.join(TMP, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch {}
    }
  } catch {}
}

// ── live upload state, broadcast to every client ─────────────────────────────
// Any window (any user) sees uploads in progress, not just the one doing the
// uploading. Progress broadcasts are throttled so a fast chunk stream doesn't
// flood the websocket.
// ── upload lock ───────────────────────────────────────────────────────────────
// When ONESVD_UPLOAD_LOCK is set (a sha256 hex of the chosen password, written
// by the installer), every WRITE operation — upload, delete, mkdir — requires
// the matching key in the x-upload-key header. Reads (view, download, zip) stay
// open. The client obtains the key by hashing the password the user types.
const UPLOAD_LOCK = (process.env.ONESVD_UPLOAD_LOCK || "").trim().toLowerCase();
if (UPLOAD_LOCK) console.log("upload lock: ENABLED (writes require password)");
function writeAllowed(req) {
  if (!UPLOAD_LOCK) return true;
  // the header carries the password itself; hash server-side (the browser can't
  // use crypto.subtle on plain-http LAN origins). Compare digests constant-time.
  const key = String(req.headers["x-upload-key"] || "");
  if (!key) return false;
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  let diff = digest.length ^ UPLOAD_LOCK.length;
  for (let i = 0; i < digest.length; i++) diff |= digest.charCodeAt(i) ^ (UPLOAD_LOCK.charCodeAt(i) || 0);
  return diff === 0;
}
function denyLocked(res) {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "locked" }));
}

// ── hub event log: a short ring of notable server events for the UI ──────────
// (uploads, deletes, builds, client connects, failures — not routine chatter)
const hubEvents = [];
function hubEvent(level, line) {
  hubEvents.push({ at: Date.now(), level, line });
  if (hubEvents.length > 30) hubEvents.shift();
  broadcast({ kind: "hublog", lines: hubEvents });
}
function fmtGB(n) {
  if (!(n > 0)) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

const activeUploads = new Map(); // id -> {id,name,dir,size,received,status,updated}
const publicUploads = () => [...activeUploads.values()].map(({ id, name, dir, size, received, status, updated }) => ({ id, name, dir, size, received, status, updated }));
let upBcastLast = 0, upBcastTimer = null;
function broadcastUploads(force = false) {
  const send = () => { upBcastLast = Date.now(); upBcastTimer = null; broadcast({ kind: "uploads", uploads: publicUploads() }); };
  if (force) { if (upBcastTimer) { clearTimeout(upBcastTimer); upBcastTimer = null; } return send(); }
  const wait = 500 - (Date.now() - upBcastLast);
  if (wait <= 0) return send();
  if (!upBcastTimer) upBcastTimer = setTimeout(send, wait); // trailing update
}
function touchUpload(id, patch) {
  const cur = activeUploads.get(id);
  activeUploads.set(id, { ...(cur || {}), id, ...patch, updated: Date.now() });
}
// prune sessions that stopped sending (closed laptop, dead tab). The on-disk
// partial stays for resume; only the live "uploading" pill goes away.
setInterval(() => {
  const cutoff = Date.now() - 120 * 1000;
  let changed = false;
  for (const [id, u] of activeUploads) if (u.updated < cutoff) { activeUploads.delete(id); changed = true; }
  if (changed) broadcastUploads(true);
}, 30 * 1000).unref?.();

function handleUploadInit(req, res) {
  readJsonBody(req, res, (opt) => {
    const name = path.basename(String(opt.name || ""));
    const size = Number(opt.size || 0);
    const dir = String(opt.dir || ".");
    if (!name || !(size > 0)) { res.writeHead(400); return res.end("bad init"); }
    const destAbs = path.resolve(ROOT, dir === "." ? "" : dir);
    if (destAbs !== ROOT && !destAbs.startsWith(ROOT + path.sep)) { res.writeHead(400); return res.end("bad dir"); }
    const key = String(opt.key || `${name}|${size}|${dir}`);
    const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
    const part = partPath(id);
    let received = 0;
    if (fs.existsSync(part)) { try { received = fs.statSync(part).size; } catch {} }
    else { try { fs.writeFileSync(part, ""); } catch (e) { res.writeHead(500); return res.end("init failed"); } }
    if (received > size) { // stale/garbage partial — start over
      try { fs.writeFileSync(part, ""); } catch {}
      received = 0;
    }
    writeMeta(id, { name, size, dir, key, created: Date.now() });
    touchUpload(id, { name, dir, size, received, status: "uploading" });
    broadcastUploads(true);
    hubEvent("info", `upload ${received > 0 ? "resumed" : "started"} · ${name} (${fmtGB(size)})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, received }));
  });
}

function handleUploadChunk(req, res) {
  const url = new URL(req.url, "https://x");
  const id = url.searchParams.get("id") || "";
  const offset = parseInt(url.searchParams.get("offset") || "-1", 10);
  const meta = readMeta(id);
  if (!meta) { res.writeHead(404); return res.end("unknown upload"); }
  const part = partPath(id);
  let curr = 0;
  try { curr = fs.statSync(part).size; } catch {}
  if (offset !== curr) { // client out of sync — tell it where we actually are
    res.writeHead(409, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ received: curr }));
  }

  // buffer the chunk (bounded), verify its hash, then append. A bad chunk is
  // rejected and never written, so the assembled file is correct by construction.
  const MAX = 16 * 1024 * 1024;
  const parts = [];
  let len = 0, tooBig = false;
  req.on("data", (d) => {
    if (tooBig) return;
    len += d.length;
    if (len > MAX) { tooBig = true; req.destroy(); return; }
    parts.push(d);
  });
  req.on("end", () => {
    if (tooBig) { if (!res.headersSent) { res.writeHead(413); res.end("chunk too large"); } return; }
    const buf = Buffer.concat(parts, len);
    const want = String(req.headers["x-chunk-sha256"] || "").toLowerCase();
    if (want) {
      const got = crypto.createHash("sha256").update(buf).digest("hex");
      if (got !== want) {
        console.warn(`[upload] chunk hash mismatch id=${id} offset=${offset}`);
        res.writeHead(422, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "chunk hash mismatch", received: curr }));
      }
    }
    let now = 0;
    try { now = fs.statSync(part).size; } catch {}
    if (now !== offset) { // raced with another write
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ received: now }));
    }
    fs.appendFile(part, buf, (err) => {
      if (err) { console.error("chunk write:", err); if (!res.headersSent) { res.writeHead(500); res.end("write error"); } return; }
      let received = 0;
      try { received = fs.statSync(part).size; } catch {}
      touchUpload(id, { name: meta.name, dir: meta.dir, size: meta.size, received, status: "uploading" });
      broadcastUploads();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received }));
    });
  });
}

function handleUploadCancel(req, res) {
  const url = new URL(req.url, "https://x");
  const id = url.searchParams.get("id") || "";
  if (!id) { res.writeHead(400); return res.end("missing id"); }
  try { fs.rmSync(partPath(id), { force: true }); } catch {}
  try { fs.rmSync(metaPath(id), { force: true }); } catch {}
  if (activeUploads.delete(id)) { broadcastUploads(true); hubEvent("info", "upload cancelled"); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function handleUploadStatus(req, res) {
  const url = new URL(req.url, "https://x");
  const id = url.searchParams.get("id") || "";
  const meta = readMeta(id);
  if (!meta) { res.writeHead(404); return res.end("unknown upload"); }
  let received = 0;
  try { received = fs.statSync(partPath(id)).size; } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ received, size: meta.size, name: meta.name, dir: meta.dir }));
}

function handleUploadFinish(req, res) {
  readJsonBody(req, res, (opt) => {
    const url = new URL(req.url, "https://x");
    const id = url.searchParams.get("id") || "";
    const meta = readMeta(id);
    if (!meta) { res.writeHead(404); return res.end("unknown upload"); }
    const part = partPath(id);
    let size = 0;
    try { size = fs.statSync(part).size; } catch {}
    if (size !== meta.size) { // completeness check
      touchUpload(id, { name: meta.name, dir: meta.dir, size: meta.size, received: size, status: "uploading" });
      broadcastUploads(true);
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "incomplete", received: size, size: meta.size }));
    }
    // whole-file integrity: hash the assembled file (streamed, native). This can
    // take minutes for very large files — surface it as "processing" everywhere.
    touchUpload(id, { name: meta.name, dir: meta.dir, size: meta.size, received: size, status: "processing" });
    broadcastUploads(true);
    const revert = () => { touchUpload(id, { status: "uploading" }); broadcastUploads(true); };
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(part);
    rs.on("error", () => { revert(); if (!res.headersSent) { res.writeHead(500); res.end("hash error"); } });
    rs.on("data", (d) => hash.update(d));
    rs.on("end", () => {
      const sha = hash.digest("hex");
      if (opt.expectedSha && String(opt.expectedSha) !== sha) {
        revert();
        hubEvent("error", `upload integrity mismatch · ${meta.name}`);
        res.writeHead(422, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "integrity mismatch", sha }));
      }
      const destDir = path.resolve(ROOT, meta.dir === "." ? "" : meta.dir);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, meta.name);
        try { fs.renameSync(part, dest); }
        catch { fs.copyFileSync(part, dest); fs.rmSync(part, { force: true }); }
      } catch (e) {
        revert();
        res.writeHead(500);
        return res.end("move failed: " + e.message);
      }
      try { fs.rmSync(metaPath(id), { force: true }); } catch {}
      activeUploads.delete(id);
      broadcastUploads(true);
      hubEvent("info", `upload complete · ${meta.name} (${fmtGB(size)})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sha256: sha, size }));
    });
  });
}

// ── delete handler ───────────────────────────────────────────────────────────

function handleDelete(req, res) {
  const url = new URL(req.url, "http://localhost");
  const rel = url.searchParams.get("path") || "";
  const target = path.resolve(ROOT, rel);
  // must be strictly inside ROOT — never ROOT itself or outside it
  if (target === ROOT || !target.startsWith(ROOT + path.sep)) {
    res.writeHead(400);
    return res.end("invalid path");
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    hubEvent("error", `delete failed · ${rel}`);
    res.writeHead(500);
    return res.end("delete failed: " + e.message);
  }
  hubEvent("info", `deleted · ${rel}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// POST /mkdir?dir=sub/path — create an empty folder. A dragged-in empty folder
// has no files to upload, so the browser sends nothing; this lets the UI
// materialize the folder explicitly. Resolves inside ROOT, never ROOT itself.
function handleMkdir(req, res) {
  const url = new URL(req.url, "http://localhost");
  const rel = safeRelPath(url.searchParams.get("dir") || "");
  if (!rel) { res.writeHead(400); return res.end("invalid dir"); }
  const target = path.resolve(ROOT, rel);
  if (target === ROOT || !target.startsWith(ROOT + path.sep)) {
    res.writeHead(400);
    return res.end("invalid dir");
  }
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    res.writeHead(500);
    return res.end("mkdir failed: " + e.message);
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, dir: rel }));
}

// ── zip handler (download a folder) ──────────────────────────────────────────

function handleZip(req, res) {
  if (!ZIP_OK) {
    res.writeHead(503);
    return res.end("zip unavailable — install the 'zip' package or the archiver npm module");
  }
  const url = new URL(req.url, "http://localhost");
  const rel = url.searchParams.get("path") || "";
  const target = path.resolve(ROOT, rel);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(400);
    return res.end("invalid path");
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    res.writeHead(404);
    return res.end("not found");
  }
  if (!stat.isDirectory()) {
    res.writeHead(400);
    return res.end("not a directory");
  }

  const folder = path.basename(target) || "onesvd";
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${folder}.zip"`,
  });

  if (archiverFn) {
    // store-only (no compression): the vault holds mostly already-compressed
    // artifacts, and DEFLATE at level 6 is single-threaded CPU work that turns
    // a multi-hundred-GB folder into hours of zipping. At level 0 the zip
    // streams at disk/network speed; integrity comes from the hashes anyway.
    const archive = archiverFn("zip", { zlib: { level: 0 } });
    archive.on("error", (e) => { console.error("zip(archiver) error:", e); try { res.destroy(); } catch {} });
    archive.pipe(res);
    archive.directory(target, folder); // nest under the folder name
    archive.finalize();
  } else {
    // system zip: run from the parent so the archive nests under `folder`
    // -r recurse, -q quiet, - write to stdout
    const zip = spawn("zip", ["-0", "-r", "-q", "-", folder], { cwd: path.dirname(target) }); // -0 = store-only, same reasoning as archiver
    zip.stdout.pipe(res);
    zip.stderr.on("data", (d) => console.error("zip:", d.toString()));
    zip.on("error", (e) => { console.error("zip spawn error:", e); try { res.destroy(); } catch {} });
    req.on("close", () => { try { zip.kill(); } catch {} }); // client gave up
  }
}

// ── file serving (moved off nginx/python so it sits behind hub auth) ─────────
const MIME = {
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".zip": "application/zip",
};
function resolveInRoot(rel) {
  const target = path.resolve(ROOT, rel || "");
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}
// GET /file?path=... (inline view) and GET /download?path=... (force download)
function handleFile(req, res, asDownload) {
  const url = new URL(req.url, "http://localhost");
  const rel = url.searchParams.get("path") || "";
  const target = resolveInRoot(rel);
  if (!target) { res.writeHead(400); return res.end("invalid path"); }
  let stat;
  try { stat = fs.statSync(target); } catch { res.writeHead(404); return res.end("not found"); }
  if (stat.isDirectory()) { res.writeHead(400); return res.end("is a directory — use /zip"); }
  const name = path.basename(target);
  const ext = path.extname(name).toLowerCase();
  const headers = {
    "Content-Type": asDownload ? "application/octet-stream" : (MIME[ext] || "application/octet-stream"),
    "Content-Length": stat.size,
    "Cache-Control": "private, no-store",
  };
  if (asDownload) headers["Content-Disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(target);
  stream.on("error", () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}

// POST /session — exchange a valid token for a session cookie. Requires the
// token (Authorization: Bearer / ?token=) AND a permitted IP; both are checked
// by the gate before we get here. Sets the HttpOnly session cookie.
function handleSession(req, res) {
  const id = newSession();
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Set-Cookie": sessionCookieHeader(id),
  });
  res.end(JSON.stringify({ ok: true }));
}
// POST /logout — drop the current session.
function handleLogout(req, res) {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (id) { sessions.delete(id); saveSessions(); }
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly;${TLS_ON ? " Secure;" : ""} SameSite=Lax`,
  });
  res.end(JSON.stringify({ ok: true }));
}
// GET /login?next=... — minimal self-contained login page. Posts the token to
// /session to obtain the cookie, then redirects to `next`. Shown when a browser
// opens a protected file/zip link without a valid session.
function handleLoginPage(req, res) {
  const url = new URL(req.url, "http://localhost");
  const next = url.searchParams.get("next") || "/";
  const safeNext = /^https?:\/\/[^"'<>]*$/i.test(next) ? next : "/";
  const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OneSVD — sign in</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#F4F6F5;
       font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{width:320px;max-width:90vw;padding:28px;border:1px solid rgba(255,255,255,.12);border-radius:14px;
        background:rgba(255,255,255,.03)}
  h1{font-size:18px;margin:0 0 4px} p{color:#6E7E7A;font-size:13px;margin:0 0 18px;line-height:1.5}
  label{font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6E7E7A}
  input{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:10px 12px;border-radius:8px;
        border:1px solid rgba(255,255,255,.16);background:#0b0f0e;color:#F4F6F5;font-family:ui-monospace,monospace;font-size:13px}
  button{width:100%;padding:10px;border:none;border-radius:8px;background:#16E1A0;color:#04130d;font-weight:700;
         font-size:14px;cursor:pointer}
  .err{color:#E0584F;font-size:12px;min-height:16px;margin-top:8px}
</style></head><body>
<div class="card">
  <h1>OneSVD</h1>
  <p>Enter your access token to continue. You'll stay signed in on this device.</p>
  <label>Access token</label>
  <input id="t" type="password" autocomplete="off" autofocus placeholder="token">
  <button id="go">Sign in</button>
  <div class="err" id="e"></div>
</div>
<script>
  var NEXT = ${JSON.stringify(safeNext)};
  var go = document.getElementById('go'), t = document.getElementById('t'), e = document.getElementById('e');
  function submit(){
    e.textContent = '';
    fetch('/session', { method:'POST', credentials:'include', headers:{ 'Authorization':'Bearer '+t.value.trim() } })
      .then(function(r){ if(!r.ok) throw new Error(r.status===401?'Invalid token':r.status===403?'Your network is not allowed':'Sign-in failed'); return r.json(); })
      .then(function(){ window.location.replace(NEXT); })
      .catch(function(err){ e.textContent = err.message || 'Sign-in failed'; });
  }
  go.onclick = submit;
  t.addEventListener('keydown', function(ev){ if(ev.key==='Enter') submit(); });
</script>
</body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(page);
}
// WARNING: cloning and building a repo runs arbitrary code on this server.
// Keep the hub access-controlled (auth / firewall) before exposing publicly.

const RUNNERS_FILE = path.join(__dirname, "runners.json"); // outside ROOT
const POLL_MS = 15000;
const SSH_DIR = "/home/ubuntu/.ssh";

// ── per-runner build logs + run history ───────────────────────────────────────
// Each build writes its own log file under runner-logs/<id>/<runId>.log (runId
// is the start timestamp). We keep the last MAX_RUNS runs per runner — their
// logs on disk and a compact pass/fail record in runner.history (persisted) —
// so you can review past runs, not just the latest. Logs survive a closed
// modal, a poll-triggered build, and a hub restart.
const RUNNER_LOG_DIR = path.join(__dirname, "runner-logs");
try { fs.mkdirSync(RUNNER_LOG_DIR, { recursive: true }); } catch {}
const MAX_RUNS = 15;              // run logs + history entries kept per runner
const LOG_RING = new Map();       // id -> current run's chunks (live tail)
const LOG_RING_MAX = 1500;
const CURRENT_RUN = new Map();    // id -> runId of the in-flight build

const runnerDir = (id) => path.join(RUNNER_LOG_DIR, safeName(id));
const runFile = (id, runId) => path.join(runnerDir(id), `${runId}.log`);

function startRunLog(id) {
  const runId = String(Date.now());
  CURRENT_RUN.set(id, runId);
  LOG_RING.set(id, []);
  try { fs.mkdirSync(runnerDir(id), { recursive: true }); fs.writeFileSync(runFile(id, runId), ""); } catch {}
  return runId;
}
function appendRunnerLog(id, chunk) {
  if (!id || !chunk) return;
  let ring = LOG_RING.get(id);
  if (!ring) { ring = []; LOG_RING.set(id, ring); }
  ring.push(chunk);
  if (ring.length > LOG_RING_MAX) ring.splice(0, ring.length - LOG_RING_MAX);
  const runId = CURRENT_RUN.get(id);
  if (runId) { try { fs.appendFileSync(runFile(id, runId), chunk); } catch {} }
}
function readRunnerLog(id, runId) {
  if (runId) { try { return fs.readFileSync(runFile(id, runId), "utf8"); } catch { return ""; } }
  const cur = CURRENT_RUN.get(id); // prefer the live run
  if (cur) { try { return fs.readFileSync(runFile(id, cur), "utf8"); } catch { return (LOG_RING.get(id) || []).join(""); } }
  try { // else newest file (runId is a sortable timestamp)
    const files = fs.readdirSync(runnerDir(id)).filter((f) => f.endsWith(".log")).sort();
    if (files.length) return fs.readFileSync(path.join(runnerDir(id), files[files.length - 1]), "utf8");
  } catch {}
  return "";
}
function pruneRuns(id, keepRunIds) {
  try {
    for (const f of fs.readdirSync(runnerDir(id))) {
      if (!f.endsWith(".log")) continue;
      if (!keepRunIds.includes(f.slice(0, -4))) { try { fs.rmSync(path.join(runnerDir(id), f)); } catch {} }
    }
  } catch {}
}
// Record a finished run in the runner's history, trim to MAX_RUNS, prune old logs.
function recordRun(runner, runId, status, sha, error) {
  if (!Array.isArray(runner.history)) runner.history = [];
  const startedAt = Number(runId) || Date.now();
  runner.history.unshift({
    runId, at: startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt,
    sha: sha ? sha.slice(0, 7) : null, status, error: error || null,
  });
  if (runner.history.length > MAX_RUNS) runner.history = runner.history.slice(0, MAX_RUNS);
  CURRENT_RUN.delete(runner.id);
  pruneRuns(runner.id, runner.history.map((h) => h.runId));
  saveRunners();
}

// Pick the SSH key to clone with. ONESVD_SSH_KEY wins; otherwise use the first
// key found in /home/ubuntu/.ssh. The hub runs as root, which can read these.
function pickSshKey() {
  if (process.env.ONESVD_SSH_KEY) return process.env.ONESVD_SSH_KEY;
  for (const name of ["onesvd_deploy", "id_ed25519", "id_ecdsa", "id_rsa"]) {
    const p = path.join(SSH_DIR, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "";
}
const SSH_KEY = pickSshKey();
let runners = []; // {id, repo, branch, dest, build, artifacts, lastSha, lastBuilt, status, error, addedAt}

// git over SSH: auto-accept new host keys, use the discovered key if present.
// GIT_TERMINAL_PROMPT=0 makes an HTTPS clone that needs credentials fail fast
// instead of hanging the runner on an interactive username/password prompt
// (public HTTPS repos clone fine; private ones should use SSH).
function gitEnv() {
  let ssh = "ssh -o StrictHostKeyChecking=accept-new";
  if (SSH_KEY && fs.existsSync(SSH_KEY)) ssh += ` -i ${SSH_KEY} -o IdentitiesOnly=yes`;
  return { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: "0" };
}
// Accept SSH (scp-style git@host:owner/repo or ssh://git@host/owner/repo) for
// any repo, OR HTTPS for PUBLIC repos (cloned with no credentials). HTTPS to a
// private repo isn't supported here — it would need a token; use SSH for those.
function isAllowedRepo(repo) {
  return (
    /^git@(github\.com|gitlab\.com):[\w.-]+\/[\w.-]+(\.git)?$/.test(repo) ||
    /^ssh:\/\/git@(github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+(\.git)?$/.test(repo) ||
    /^https:\/\/(www\.)?(github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(repo)
  );
}

function loadRunners() {
  try {
    runners = JSON.parse(fs.readFileSync(RUNNERS_FILE, "utf8"));
    for (const r of runners) {
      r.status = "idle"; r.error = null; // transient fields reset
      r.phase = null; r.buildStartedAt = null;
      if (!Array.isArray(r.history)) r.history = []; // run history persists
      if (!Array.isArray(r.written)) r.written = []; // tolerate older files
      // migrate records that predate the explicitBranch flag: if a branch is
      // stored, treat it as user-specified so it's never silently rewritten to
      // the default. (Auto-switch is only for runners with NO branch set.)
      if (r.explicitBranch === undefined) r.explicitBranch = !!(r.branch && String(r.branch).trim());
    }
    console.log(`git runners: loaded ${runners.length}`);
  } catch {
    runners = [];
  }
}
function saveRunners() {
  try {
    const persist = runners.map((r) => ({
      id: r.id, repo: r.repo, branch: r.branch, dest: r.dest,
      build: r.build, artifacts: r.artifacts, submodules: !!r.submodules,
      explicitBranch: !!r.explicitBranch, lastSha: r.lastSha,
      lastBuilt: r.lastBuilt, addedAt: r.addedAt,
      history: Array.isArray(r.history) ? r.history.slice(0, MAX_RUNS) : [],
      written: r.written || [], // artifact paths — drives the purple UI after a restart
    }));
    fs.writeFileSync(RUNNERS_FILE, JSON.stringify(persist, null, 2));
  } catch (e) {
    console.error("saveRunners:", e);
  }
}
function publicRunner(r) {
  return {
    id: r.id, repo: r.repo, branch: r.branch, dest: r.dest,
    written: r.written || [],
    lastSha: r.lastSha, lastBuilt: r.lastBuilt, lastChecked: r.lastChecked || null,
    status: r.status, error: r.error,
    phase: r.phase || null, buildStartedAt: r.buildStartedAt || null,
    history: Array.isArray(r.history) ? r.history : [],
  };
}
function broadcastRunners() {
  broadcast({ kind: "runners", runners: runners.map(publicRunner) });
}

function safeName(s) {
  return (String(s || "").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "")) || "repo";
}
// dest may be a nested path (the folder the user was standing in). Keep slashes,
// drop any traversal/leading slashes, and sanitize each segment — so "a/b/c" is
// allowed but "../x" or absolute paths are not.
function safeRelPath(s) {
  const parts = String(s || "")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[^a-zA-Z0-9._ -]/g, "-"));
  return parts.join("/");
}
function repoNameFromUrl(u) {
  const m = String(u).replace(/\.git$/, "").match(/\/([^/]+)\/?$/);
  return m ? safeName(m[1]) : "repo";
}
function gitMsg(id, phase, extra = {}) {
  broadcast({ kind: "git", id, phase, ...extra });
  if (phase === "cloning" || phase === "done" || phase === "error") {
    const r = runners.find((x) => x.id === id);
    const name = r ? shortRepoLog(r.repo) : id;
    if (phase === "cloning") hubEvent("info", `runner build started · ${name}`);
    else if (phase === "done") hubEvent("info", `runner build complete · ${name}`);
    else hubEvent("error", `runner build failed · ${name}`);
  }
}
// Stream a child process's output as runner log lines (broadcast + persisted).
// Guards against hangs, which is what made a huge ardupilot clone look dead:
//   guard.idleMs — no output for this long ⇒ considered stuck, killed
//   guard.maxMs  — absolute cap on total runtime
// A heartbeat line is emitted during quiet stretches so the UI shows liveness.
function runStreamed(id, cmd, args, opts, guard = {}) {
  const idleMs = guard.idleMs || 0;
  const maxMs = guard.maxMs || 0;
  const label = guard.label || cmd;
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, opts);
    } catch (e) {
      const line = `spawn error: ${e.message}\n`;
      gitMsg(id, "log", { line }); appendRunnerLog(id, line);
      return resolve(1);
    }
    const started = Date.now();
    let lastOut = Date.now();
    let killed = "";
    const emit = (line) => { gitMsg(id, "log", { line }); appendRunnerLog(id, line); };

    let idleTimer = null, maxTimer = null, beat = null;
    const clearAll = () => { clearInterval(beat); clearTimeout(idleTimer); clearTimeout(maxTimer); };
    const killTree = (reason) => {
      if (killed) return;
      killed = reason;
      emit(`\n✕ ${label}: ${reason} — terminating\n`);
      try { p.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 5000);
    };
    const armIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killTree(`no output for ${Math.round(idleMs / 1000)}s`), idleMs);
    };
    if (maxMs) maxTimer = setTimeout(() => killTree(`exceeded ${Math.round(maxMs / 1000)}s limit`), maxMs);
    // heartbeat: during a quiet stretch (no process output for 15s) note that
    // it's still alive and how long it's been running.
    beat = setInterval(() => {
      if (Date.now() - lastOut >= 15000) emit(`… ${label} still running (${Math.round((Date.now() - started) / 1000)}s)\n`);
    }, 20000);
    armIdle();

    const onData = (d) => { lastOut = Date.now(); emit(d.toString()); armIdle(); };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", (e) => { clearAll(); emit(`error: ${e.message}\n`); resolve(1); });
    p.on("close", (code) => {
      clearAll();
      if (killed) return resolve(124); // timed out / killed
      resolve(code == null ? 1 : code);
    });
  });
}

// minimal YAML subset parser: top-level "key: value" and "key:\n  - item" lists.
function parseConfig(text) {
  const cfg = {};
  const lines = String(text).split(/\r?\n/);
  const unquote = (v) => {
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i].replace(/^#.*$/, "").replace(/\s+#.*$/, "");
    if (!raw.trim()) { i++; continue; }
    const m = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2];
    if (val.trim() === "") {
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const lm = lines[j].replace(/\s+#.*$/, "").match(/^\s*-\s+(.*)$/);
        if (!lm) break;
        list.push(unquote(lm[1]));
        j++;
      }
      cfg[key] = list.length ? list : "";
      i = j;
    } else {
      cfg[key] = unquote(val);
      i++;
    }
  }
  return cfg;
}
function readRepoConfig(repoDir) {
  for (const name of [".onesvd.yml", ".onesvd.yaml", "onesvd.yml"]) {
    const p = path.join(repoDir, name);
    if (fs.existsSync(p)) {
      try { return parseConfig(fs.readFileSync(p, "utf8")); } catch { return {}; }
    }
  }
  return {};
}
function normalizeBuild(b) {
  if (!b) return "";
  if (Array.isArray(b)) return b.filter(Boolean).join(" && ");
  return String(b);
}

async function buildRunner(runner) {
  if (runner.status === "building") return;
  runner.status = "building";
  runner.error = null;
  runner.phase = "cloning";
  runner.buildStartedAt = Date.now();
  broadcastRunners();

  const id = runner.id;
  const runId = startRunLog(id); // new per-run log
  let sha = "";                  // hoisted so the catch block can record it
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onesvd-git-"));
  const repoDir = path.join(tmp, "repo");
  try {
    gitMsg(id, "cloning", { repo: runner.repo, dest: runner.dest });
    // --progress forces git to emit progress over a pipe (it stays silent on a
    // non-TTY otherwise — which is why a big clone looked hung with no logs).
    const cloneArgs = ["clone", "--depth", "1", "--progress"];
    if (runner.branch) cloneArgs.push("--branch", runner.branch);
    cloneArgs.push(runner.repo, repoDir);
    if ((await runStreamed(id, "git", cloneArgs, { cwd: tmp, env: gitEnv() },
      { label: "clone", idleMs: 180000, maxMs: 1800000 })) !== 0) throw new Error("clone failed or timed out");

    // capture the commit we're building. We DON'T advance runner.lastSha yet —
    // only after a successful build — so a failed/interrupted build retries on
    // the next poll instead of being silently skipped.
    sha = (spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"]).stdout || "").toString().trim();

    // config: repo's .onesvd.yml overrides the runner's stored defaults
    const cfg = readRepoConfig(repoDir);
    // A branch named in .onesvd.yml is only honored if that branch ACTUALLY
    // exists on the remote. This avoids a stale/incorrect config (e.g. branch:
    // main on a repo whose only branch is master) silently breaking the runner
    // by making it track a branch that doesn't exist.
    const cfgBranch = cfg.branch ? String(cfg.branch).trim() : "";
    if (cfgBranch && cfgBranch !== runner.branch) {
      const chk = await gitAsync(["ls-remote", "--heads", runner.repo, cfgBranch]);
      const exists = chk.ok && chk.stdout.trim().length > 0;
      if (exists) {
        console.log(`[runner] ${shortRepoLog(runner.repo)}: .onesvd.yml branch '${cfgBranch}' adopted`);
        runner.branch = cfgBranch;
        runner.explicitBranch = true; // config branch is intentional — don't auto-switch it
      } else {
        console.warn(`[runner] ${shortRepoLog(runner.repo)}: .onesvd.yml branch '${cfgBranch}' does not exist on remote — ignoring, keeping '${runner.branch || "(default)"}'`);
      }
    }
    const build = normalizeBuild(cfg.build) || runner.build || "";
    const dest = safeRelPath(cfg.dest || runner.dest); // may be nested, e.g. "LargeStuff" or "a/b"
    const destAbs = dest === "" ? ROOT : path.resolve(ROOT, dest);
    if (destAbs !== ROOT && !destAbs.startsWith(ROOT + path.sep)) throw new Error("invalid destination");

    // artifacts: a single path or a list; each entry may be a file or a dir
    const aSrc = cfg.artifacts !== undefined && cfg.artifacts !== "" ? cfg.artifacts : runner.artifacts;
    const artifactList = (Array.isArray(aSrc) ? aSrc : aSrc ? [aSrc] : [])
      .map((x) => String(x).trim().replace(/^\/+/, ""))
      .filter(Boolean);

    // Nothing to build and no artifacts named — drop the whole repo (minus .git)
    // into a single folder named after the repo, e.g. base1/bitcoin/. This is
    // the "just track this repo" mode; commit a .onesvd.yml to build and store
    // specific outputs instead.
    if (!build && artifactList.length === 0) {
      const subName = repoNameFromUrl(runner.repo);        // e.g. "bitcoin"
      const target = path.join(destAbs, subName);          // …/base1/bitcoin
      const rel = dest ? dest + "/" + subName : subName;    // base1/bitcoin
      gitMsg(id, "log", { line: `no build configured — storing the repo in /${rel}\n` });
      appendRunnerLog(id, `no build configured — storing the repo (minus .git) at ${target}\n`);
      runner.phase = "copying"; broadcastRunners();

      // remove what this runner wrote last time, then copy the repo into its folder
      for (const prev of runner.written || []) {
        const p = path.resolve(ROOT, prev);
        if (p.startsWith(ROOT + path.sep)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
      }
      fs.mkdirSync(destAbs, { recursive: true });
      const noGit = (s) => !s.split(path.sep).includes(".git");
      fs.cpSync(repoDir, target, { recursive: true, filter: noGit });
      const written = [rel];

      // close the log with how to switch to a build-and-store setup
      const guide =
        `\nStored the repo at ${target}\n\n` +
        `To build this repo and store only its outputs instead of the whole repo,\n` +
        `commit a .onesvd.yml to the repo root, for example:\n\n` +
        `  build: <command to build the repo>\n` +
        `  artifacts: <path to the build outputs>\n` +
        `  # submodules: true   # if the repo needs them\n\n` +
        `Docs: https://onesvd.com/docs/guides/git-runners\n`;
      gitMsg(id, "log", { line: guide });
      appendRunnerLog(id, guide);

      runner.dest = dest;
      runner.written = written;
      runner.lastSha = sha;
      runner.lastBuilt = Date.now();
      runner.status = "idle";
      runner.error = null;
      runner.phase = "done";
      runner.buildStartedAt = null;
      recordRun(runner, runId, "success", sha);
      saveRunners();
      broadcastRunners();
      gitMsg(id, "done", { dest, sha: sha.slice(0, 7) });
      return; // finally{} still cleans up the temp checkout
    }

    // Optional submodules (heavy) — opt in via the runner (GUI) or `submodules:
    // true` in .onesvd.yml. Repos like ardupilot don't build without them; most
    // repos don't need them.
    const wantSubmodules = !!runner.submodules || /^(1|true|yes)$/i.test(String(cfg.submodules || "").trim());
    if (wantSubmodules) {
      runner.phase = "submodules"; broadcastRunners();
      gitMsg(id, "building", { cmd: "git submodule update --init --recursive" });
      if ((await runStreamed(id, "git", ["-C", repoDir, "submodule", "update", "--init", "--recursive", "--depth", "1", "--progress"],
        { env: gitEnv() }, { label: "submodules", idleMs: 180000, maxMs: 1800000 })) !== 0) throw new Error("submodule fetch failed or timed out");
    }

    if (build) {
      runner.phase = "building"; broadcastRunners();
      gitMsg(id, "building", { cmd: build });
      if ((await runStreamed(id, "bash", ["-lc", build], { cwd: repoDir },
        { label: "build", idleMs: 600000, maxMs: 3600000 })) !== 0) throw new Error("build failed or timed out");
    } else {
      gitMsg(id, "log", { line: "no build step detected\n" });
    }

    runner.phase = "copying"; broadcastRunners();
    gitMsg(id, "copying", { dest });
    // Deliver INTO dest without destroying the folder's other contents. We remove
    // only the entries this runner wrote on its previous build, then write fresh
    // ones — so artifacts live alongside whatever else is in the folder.
    for (const prev of runner.written || []) {
      const p = path.resolve(ROOT, prev);
      if (p.startsWith(ROOT + path.sep)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    }
    fs.mkdirSync(destAbs, { recursive: true });
    const noGit = (s) => !s.split(path.sep).includes(".git");
    const written = []; // relative paths this build produced (for next-build cleanup)
    const joinRel = (name) => (dest ? dest + "/" + name : name);

    if (artifactList.length) {
      // copy ONLY the named artifacts: a dir's contents land under dest/<name>/,
      // a file lands as dest/<basename>
      for (const rel of artifactList) {
        const src = path.join(repoDir, rel);
        if (!path.resolve(src).startsWith(path.resolve(repoDir) + path.sep)) {
          throw new Error(`invalid artifact path '${rel}'`);
        }
        if (!fs.existsSync(src)) throw new Error(`artifact '${rel}' not found in repo`);
        const base = path.basename(src);
        const target = path.join(destAbs, base);
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, target, { recursive: true, filter: noGit });
          gitMsg(id, "log", { line: `artifact: ${rel}/ -> ${dest || "/"}/${base}/\n` });
        } else {
          fs.copyFileSync(src, target);
          gitMsg(id, "log", { line: `artifact: ${rel} -> ${dest || "/"}/${base}\n` });
        }
        written.push(joinRel(base));
      }
    } else {
      // No artifacts named, but a build ran — store its output. Auto-detect a
      // standard build-output dir; if none exists, fail clearly rather than
      // dumping the whole repo (which would store source, not artifacts).
      let picked = "";
      for (const c of ["dist", "build", "out", "public"]) {
        if (fs.existsSync(path.join(repoDir, c))) { picked = c; break; }
      }
      if (!picked) throw new Error("build finished but no artifacts found — set `artifacts` to the output path(s), e.g. build/ or dist/");
      const subName = repoNameFromUrl(runner.repo);
      const target = path.join(destAbs, subName);
      gitMsg(id, "log", { line: `artifacts: ${picked}/ -> ${dest || "/"}/${subName}/\n` });
      fs.cpSync(path.join(repoDir, picked), target, { recursive: true, filter: noGit });
      written.push(joinRel(subName));
    }

    runner.dest = dest;
    runner.written = written;
    runner.lastSha = sha; // only now mark this commit built
    runner.lastBuilt = Date.now();
    runner.status = "idle";
    runner.error = null;
    runner.phase = "done";
    runner.buildStartedAt = null;
    recordRun(runner, runId, "success", sha);
    saveRunners();
    broadcastRunners();
    gitMsg(id, "done", { dest, sha: sha.slice(0, 7) });
  } catch (e) {
    runner.status = "error";
    runner.error = e.message || String(e);
    runner.phase = "error";
    runner.buildStartedAt = null;
    appendRunnerLog(id, `\n✕ ${runner.error}\n`); // keep the failure in the saved log
    recordRun(runner, runId, "error", sha, runner.error);
    broadcastRunners();
    gitMsg(id, "error", { message: runner.error });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// poll every repo for a moved HEAD; build when the commit changed
let pollInFlight = false;
async function pollRunners() {
  if (runners.length === 0) return;
  if (pollInFlight) return; // a slow remote must not stack overlapping polls
  pollInFlight = true;
  try {
  console.log(`[poll] checking ${runners.length} runner(s)`);
  let changed = false;
  for (const runner of runners) {
    if (runner.status === "building") { console.log(`[poll] ${shortRepoLog(runner.repo)} is building — skip`); continue; }
    try {
      let branch = runner.branch || "";
      // self-heal older runners that have no branch: detect the default and store it
      if (!branch) {
        branch = await detectDefaultBranch(runner.repo);
        if (branch) {
          runner.branch = branch;
          saveRunners();
          console.log(`[poll] ${shortRepoLog(runner.repo)}: adopted default branch '${branch}'`);
        }
      }
      // ls-remote returns "<sha>\t<ref>" lines. Ask for the branch (or HEAD).
      const ref = branch || "HEAD";
      const out = await gitAsync(["ls-remote", runner.repo, ref]);
      runner.lastChecked = Date.now();
      changed = true;
      if (!out.ok) {
        console.warn(`[poll] ls-remote FAILED ${shortRepoLog(runner.repo)} (${ref}): ${out.stderr.trim() || "nonzero exit"}`);
        hubEvent("warn", `runner poll failed · ${shortRepoLog(runner.repo)}`);
        continue; // transient; try again next cycle
      }
      const lines = out.stdout.trim().split("\n").filter(Boolean);
      let pick = "";
      if (branch) {
        const exact = lines.find((l) => l.split(/\s+/)[1] === `refs/heads/${branch}`);
        pick = exact || lines[0] || "";
      } else {
        pick = lines[0] || "";
      }
      let sha = pick.split(/\s+/)[0];
      // stored branch no longer exists on the remote. If the branch was NOT
      // user-specified (auto-detected default that has since moved/renamed),
      // re-detect and adopt the new default. If the user explicitly chose this
      // branch, leave it alone — it should surface as an error, not be rewritten.
      if (!sha && branch && !runner.explicitBranch) {
        const def = await detectDefaultBranch(runner.repo);
        if (def && def !== branch) {
          console.warn(`[poll] ${shortRepoLog(runner.repo)}: auto-detected branch '${branch}' not found — switching to default '${def}'`);
          runner.branch = def;
          saveRunners();
          const out2 = await gitAsync(["ls-remote", runner.repo, def]);
          if (out2.ok) {
            const l2 = out2.stdout.trim().split("\n").filter(Boolean);
            const ex2 = l2.find((l) => l.split(/\s+/)[1] === `refs/heads/${def}`) || l2[0] || "";
            sha = ex2.split(/\s+/)[0];
            branch = def;
          }
        }
      }
      const remote = sha ? sha.slice(0, 7) : "none";
      const built = runner.lastSha ? runner.lastSha.slice(0, 7) : "none";
      if (!sha) {
        if (branch && runner.explicitBranch) {
          // user explicitly chose a branch that isn't on the remote — make it visible
          const msg = `branch '${branch}' does not exist on remote`;
          console.warn(`[poll] ${shortRepoLog(runner.repo)}: ${msg}`);
          if (runner.status !== "error" || runner.error !== msg) {
            runner.status = "error";
            runner.error = msg;
            saveRunners();
          }
        } else {
          console.warn(`[poll] ${shortRepoLog(runner.repo)} (${branch || "HEAD"}): no remote sha (lines=${lines.length})`);
        }
        continue;
      }
      if (sha !== runner.lastSha) {
        console.log(`[poll] ${shortRepoLog(runner.repo)} ${branch || "HEAD"}: remote ${remote} != built ${built} -> BUILDING`);
        buildRunner(runner);
      } else {
        console.log(`[poll] ${shortRepoLog(runner.repo)} ${branch || "HEAD"}: up to date (${built})`);
      }
    } catch (e) {
      console.error(`[poll] error checking ${shortRepoLog(runner.repo)}:`, e && e.message ? e.message : e);
    }
  }
  if (changed) broadcastRunners(); // push lastChecked timestamps to the UI
  } finally { pollInFlight = false; }
}
function shortRepoLog(url) {
  return String(url).replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
}

// Detect the remote's default branch (what HEAD points to) so a runner created
// without an explicit branch tracks the real default — main, master, or other —
// instead of guessing. Returns "" if it can't be determined.
// Async git call that never blocks the event loop. The sync version froze the
// entire hub — including in-flight upload chunks — for the full network
// round-trip (up to the 20s timeout on a bad day).
function gitAsync(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try { child = spawn("git", args, { env: gitEnv() }); }
    catch (e) { return resolve({ ok: false, stdout: "", stderr: String(e && e.message || e) }); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, stdout: "", stderr: String(e && e.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout: out, stderr: err }); });
  });
}

async function detectDefaultBranch(repo) {
  const out = await gitAsync(["ls-remote", "--symref", repo, "HEAD"]);
  if (!out.ok) return "";
  // line looks like: "ref: refs/heads/master\tHEAD"
  const m = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(out.stdout);
  return m ? m[1] : "";
}

function handleAddRunner(req, res) {
  if (!hasGit) { res.writeHead(503); return res.end("git not available on server"); }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", async () => {
    let opt;
    try { opt = JSON.parse(body || "{}"); } catch { res.writeHead(400); return res.end("bad json"); }

    const repo = String(opt.repo || "").trim();
    if (!isAllowedRepo(repo)) {
      res.writeHead(400);
      return res.end("repo must be a GitHub/GitLab URL — SSH (git@github.com:owner/repo.git) or HTTPS for public repos (https://github.com/owner/repo.git)");
    }
    // Destination is the folder the user is in when they add the runner (the
    // frontend sends it, "" for the watch root). No repo-name subfolder default.
    const dest = safeRelPath(opt.dest || "");
    const destAbs = dest === "" ? ROOT : path.resolve(ROOT, dest);
    if (destAbs !== ROOT && !destAbs.startsWith(ROOT + path.sep)) {
      res.writeHead(400);
      return res.end("invalid destination");
    }
    // resolve the branch: use the one given, else detect the repo's default
    // branch (main/master/other) so the poll tracks the right ref from the start.
    // explicitBranch records whether the user chose it: an explicit branch is
    // never auto-switched to the default, even if it doesn't exist on the remote.
    const explicitBranch = !!(opt.branch && String(opt.branch).trim());
    let branch = explicitBranch ? String(opt.branch).trim() : "";
    if (!branch) {
      branch = await detectDefaultBranch(repo);
      if (branch) console.log(`[runner] ${shortRepoLog(repo)}: detected default branch '${branch}'`);
      else console.warn(`[runner] ${shortRepoLog(repo)}: could not detect default branch; will track HEAD`);
    }
    const runner = {
      id: "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      repo,
      branch,
      explicitBranch,
      dest,
      build: opt.build ? String(opt.build) : "",
      artifacts: opt.artifacts ? String(opt.artifacts).replace(/^\/+/, "").trim() : "",
      submodules: /^(1|true|yes|on)$/i.test(String(opt.submodules ?? "")),
      written: [],
      lastSha: null, lastBuilt: null, status: "idle", error: null, addedAt: Date.now(),
    };
    runners.push(runner);
    saveRunners();
    broadcastRunners();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: runner.id }));
    buildRunner(runner); // first build right away
  });
}

function handleListRunners(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ runners: runners.map(publicRunner) }));
}

// GET /runners/logs?id=&run= — a runner's build log. Without run=, the latest
// (or live) build; with run=<runId>, that specific past run.
function handleRunnerLogs(req, res) {
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id") || "";
  const run = url.searchParams.get("run") || "";
  if (!id) { res.writeHead(400); return res.end("missing id"); }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(readRunnerLog(id, run || undefined));
}

function handleDeleteRunner(req, res) {
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id") || "";
  const i = runners.findIndex((r) => r.id === id);
  if (i === -1) { res.writeHead(404); return res.end("no such runner"); }
  runners.splice(i, 1); // stop polling; leaves any built artifacts in place
  saveRunners();
  broadcastRunners();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// POST /runners/build?id= — force an immediate rebuild (ignores SHA check).
function handleBuildRunner(req, res) {
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id") || "";
  const runner = runners.find((r) => r.id === id);
  if (!runner) { res.writeHead(404); return res.end("no such runner"); }
  if (runner.status === "building") { res.writeHead(409); return res.end("already building"); }
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, id }));
  console.log(`[runner] manual rebuild requested: ${shortRepoLog(runner.repo)}`);
  buildRunner(runner); // async; progress streams over WS as usual
}

// ── public server (browsers): WebSocket + POST /upload ───────────────────────
// HTTPS when TLS certs are configured (production), else plain HTTP (localhost).

const requestHandler = (req, res) => {
    try {
      const ip = socketIp(req);
      console.log(`[req] ${ip}  ${req.method} ${req.url}`);

      // CORS: echo the specific origin and allow credentials so the app (served
      // from a different port) can call /session and have the cookie stored.
      const origin = req.headers["origin"];
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Chunk-Sha256, X-Upload-Key");

      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

      // gate 1 — network allowlist (every endpoint)
      if (!ipAllowed(ip)) {
        console.warn(`[auth] ip blocked ${ip}  ${req.method} ${req.url}`);
        res.writeHead(403);
        return res.end("ip not allowed");
      }

      // /login is the only unauthenticated page (it's how you get a session).
      if (req.method === "GET" && req.url.startsWith("/login")) return handleLoginPage(req, res);

      // gate 2 — token OR session cookie (every other endpoint)
      if (!requestAuthed(req)) {
        // browser navigations bounce to the login page (with return path); API
        // callers (curl/fetch) get a plain 401.
        if (isNavigation(req)) {
          // build an absolute return URL from the configured public host (prod)
          // or from the request's own Host header (localhost) — no hardcoded domain.
          const scheme = TLS_ON ? "https" : "http";
          const host = PUBLIC_HOST || req.headers["host"] || `127.0.0.1:${WSS_PORT}`;
          const full = `${scheme}://${host}${req.url}`;
          const loc = "/login?next=" + encodeURIComponent(full);
          console.warn(`[auth] no session, redirecting to login  ${ip}  ${req.url}`);
          res.writeHead(302, { Location: loc });
          return res.end();
        }
        console.warn(`[auth] bad/missing token ${ip}  ${req.method} ${req.url}`);
        res.writeHead(401, { "WWW-Authenticate": "Bearer" });
        return res.end("missing or invalid token");
      }

      if (req.method === "POST" && req.url.startsWith("/session")) return handleSession(req, res);
      if (req.method === "POST" && req.url.startsWith("/logout")) return handleLogout(req, res);
      // verify an upload-lock key without performing any write
      if (req.method === "POST" && req.url.startsWith("/unlock")) {
        if (!UPLOAD_LOCK) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, locked: false })); }
        if (writeAllowed(req)) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, locked: true })); }
        return denyLocked(res);
      }
      // write operations respect the upload lock; reads (view/download/zip) do not
      if (req.method === "POST" && /^\/(upload|mkdir|delete)/.test(req.url) && !writeAllowed(req)) return denyLocked(res);
      if (req.method === "POST" && req.url.startsWith("/upload/init")) return handleUploadInit(req, res);
      if (req.method === "POST" && req.url.startsWith("/upload/chunk")) return handleUploadChunk(req, res);
      if (req.method === "POST" && req.url.startsWith("/upload/finish")) return handleUploadFinish(req, res);
      if (req.method === "POST" && req.url.startsWith("/upload/cancel")) return handleUploadCancel(req, res);
      if (req.method === "GET" && req.url.startsWith("/upload/status")) return handleUploadStatus(req, res);
      if (req.method === "POST" && req.url.startsWith("/upload")) return handleUpload(req, res);
      if (req.method === "POST" && req.url.startsWith("/mkdir")) return handleMkdir(req, res);
      if (req.method === "POST" && req.url.startsWith("/delete")) return handleDelete(req, res);
      if (req.method === "POST" && req.url.startsWith("/runners/delete")) return handleDeleteRunner(req, res);
      if (req.method === "POST" && req.url.startsWith("/runners/build")) return handleBuildRunner(req, res);
      if (req.method === "GET" && req.url.startsWith("/runners/logs")) return handleRunnerLogs(req, res);
      if (req.method === "POST" && req.url.startsWith("/git")) return handleAddRunner(req, res);
      if (req.method === "GET" && req.url.startsWith("/runners")) return handleListRunners(req, res);
      if (req.method === "GET" && req.url.startsWith("/zip")) return handleZip(req, res);
      if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/download")) return handleFile(req, res, true);
      if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/file")) return handleFile(req, res, false);

      res.writeHead(404);
      res.end();
    } catch (e) {
      console.error("request error:", e);
      if (!res.headersSent) { res.writeHead(500); res.end("server error"); }
      else { try { res.destroy(); } catch {} }
    }
};

// HTTPS in production (certs present), plain HTTP for the localhost profile.
const tlsServer = TLS_ON
  ? https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, requestHandler)
  : http.createServer(requestHandler);

const wss = new WebSocket.Server({ server: tlsServer });

wss.on("connection", (ws, req) => {
  const ip = socketIp(req);
  if (!ipAllowed(ip)) {
    console.warn(`[auth] ws ip blocked ${ip}`);
    try { ws.close(4403, "ip not allowed"); } catch {}
    return;
  }
  if (!tokenOk(req)) {
    console.warn(`[auth] ws bad/missing token ${ip}`);
    try { ws.close(4401, "auth required"); } catch {}
    return;
  }
  console.log(`[ws]  ${ip}  connected`);
  hubEvent("info", `client connected · ${ip}`);
  // small state first: these are bytes, the snapshot is tens of MB. Sending the
  // snapshot first made the lock/uploads/resume UI wait behind its stringify,
  // transfer, and parse — the client can act on these instantly instead.
  ws.send(JSON.stringify({ kind: "root", id: ROOT_ID }));
  ws.send(JSON.stringify({ kind: "lock", locked: UPLOAD_LOCK !== "" }));
  ws.send(JSON.stringify({ kind: "uploads", uploads: publicUploads() }));
  ws.send(JSON.stringify({ kind: "runners", runners: runners.map(publicRunner) }));
  ws.send(JSON.stringify({ kind: "watcher", ...watcherStatus }));
  ws.send(JSON.stringify({ kind: "hublog", lines: hubEvents }));
  const disk = diskInfo();
  if (disk) ws.send(JSON.stringify({ kind: "disk", disk }));
  if (tree) ws.send(JSON.stringify({ kind: "snapshot", version, tree }));
});

// push disk/quota usage to all clients periodically (free space drifts
// independently of file events; uploads/builds/deletes all move it)
setInterval(() => {
  const disk = diskInfo();
  if (disk) broadcast({ kind: "disk", disk });
}, 10000);

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

tlsServer.listen(WSS_PORT, "0.0.0.0", () => {
  const scheme = TLS_ON ? "https" : "http";
  const wsScheme = TLS_ON ? "wss" : "ws";
  const host = PUBLIC_HOST || `localhost:${WSS_PORT}`;
  console.log(`hub: ${TLS_ON ? "TLS" : "HTTP"} on :${WSS_PORT}  (${wsScheme}://${host}, ${scheme}://${host}/upload)`);
});
console.log(
  `auth: token ${AUTH_TOKEN ? "ON" : "off"}, ip allowlist ${ALLOW_IPS.length ? ALLOW_IPS.join(",") : "off"}`
);
if (!AUTH_TOKEN && ALLOW_IPS.length === 0) {
  console.warn("auth: WARNING — no token and no IP allowlist; write endpoints are open");
}

// ── loopback ingest (Go watcher) ─────────────────────────────────────────────

const ingest = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/uploads-active") {
    // the watcher asks this right before each reconcile tick, so it can defer
    // its stat-storm while a client is actively uploading (I/O contention)
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ active: activeUploads.size }));
  }
  if (req.method === "POST" && req.url === "/ingest") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        handleIngest(JSON.parse(body));
      } catch (e) {
        res.writeHead(400);
        return res.end(String(e));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

ingest.listen(INGEST_PORT, "127.0.0.1", () =>
  console.log(`hub: ingest on http://127.0.0.1:${INGEST_PORT}/ingest (loopback only)`)
);

// Last-resort guards so one bad request can't take the hub down silently.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

// clean up stale partial uploads (older than 24h)
sweepTemps();
setInterval(sweepTemps, 3600 * 1000);

// git runners: load persisted runners, poll for new commits
if (hasGit) {
  console.log(
    `ssh key: ${SSH_KEY ? `${SSH_KEY} (${fs.existsSync(SSH_KEY) ? "found" : "MISSING"})` : "none — using ssh defaults"}`
  );
  loadRunners();
  broadcastRunners();
  setInterval(pollRunners, POLL_MS);
  setTimeout(pollRunners, 4000); // first check shortly after boot
}

// ensure the watched root exists (first run on a fresh machine has no dir yet)
try { fs.mkdirSync(ROOT, { recursive: true }); console.log(`root: ${ROOT}`); }
catch (e) { console.error(`root: could not create ${ROOT}:`, e.message); }

// The hub writes runner artifacts into ROOT. If ONESVD_ROOT isn't set, ROOT is a
// default that almost certainly isn't the directory the watcher is watching — so
// artifacts would land somewhere invisible. Make that loud rather than silent.
if (!process.env.ONESVD_ROOT) {
  console.warn(`⚠ ONESVD_ROOT is not set — using default ${ROOT}. If that is not your watched directory, set ONESVD_ROOT to it (the same value as 'onesvd dir') or runner artifacts will land where the watcher can't see them.`);
}

// restore login sessions so a restart doesn't sign everyone out
loadSessions();

// restore the last-known tree so browsers see it immediately on boot (the Go
// watcher will overwrite/resync it as soon as it sends fresh data)
loadTree();
if (tree) broadcast({ kind: "snapshot", version, tree });

// ── persist state on shutdown ────────────────────────────────────────────────
// Flush in-memory state to disk so the next boot can load the last known good
// state. Runners and sessions are already saved on every change; this is a
// final safety flush on a clean exit/restart (systemctl stop/restart, Ctrl-C).
let shuttingDown = false;
function persistAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`hub: ${signal} received — saving state`);
  try { saveRunners(); } catch {}
  try { saveSessions(); } catch {}
  try { saveTreeNow(); } catch {}
  // give logs a tick to flush, then exit
  setTimeout(() => process.exit(0), 50);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => persistAndExit(sig));
}
process.on("beforeExit", () => { try { saveRunners(); saveSessions(); saveTreeNow(); } catch {} });
