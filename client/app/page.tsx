"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ── config ──────────────────────────────────────────────────────────────────
const APP_VERSION = "1.4.0"; // OneSVD interface version
const BUILD_HASH = "895cc96"; // OneSVD software build identifier (bump on release)

// Hub URL is derived at runtime from the page's own location so the same build
// runs anywhere — localhost over HTTP or a domain over HTTPS — with no rebuild.
//   - scheme: https/wss when the page is HTTPS, else http/ws (localhost profile)
//   - host:   the hostname the page was served from
//   - port:   the hub port (default 4000), overridable at build via env
// An explicit NEXT_PUBLIC_ONESVD_HUB_URL wins outright if set (e.g. behind a
// reverse proxy that puts the hub on a path/subdomain).
const HUB_PORT = process.env.NEXT_PUBLIC_ONESVD_HUB_PORT || "4000";
function deriveHubBase(): { http: string; ws: string } {
  // SSR / no window: harmless placeholder; the client re-evaluates on mount use.
  if (typeof window === "undefined") {
    return { http: "http://localhost:" + HUB_PORT, ws: "ws://localhost:" + HUB_PORT };
  }
  const explicit = process.env.NEXT_PUBLIC_ONESVD_HUB_URL;
  if (explicit) {
    const u = new URL(explicit);
    const ws = (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host;
    return { http: u.origin, ws };
  }
  const secure = window.location.protocol === "https:";
  const host = window.location.hostname;
  const httpScheme = secure ? "https" : "http";
  const wsScheme = secure ? "wss" : "ws";
  const base = `${host}:${HUB_PORT}`;
  return { http: `${httpScheme}://${base}`, ws: `${wsScheme}://${base}` };
}
const HUB = deriveHubBase();

const WS_URL = HUB.ws;
// Files are served by the Node hub (behind its auth) — /file renders inline
// (view), /download forces a download. URLs carry NO token: a browser session
// cookie (set when you enter the token) authorizes them, so links in the
// CSV/elsewhere are safe to share without leaking the token.
const VIEW_BASE = `${HUB.http}/file`;
const DOWNLOAD_BASE = `${HUB.http}/download`;
const DELETE_URL = `${HUB.http}/delete`;
const ZIP_BASE = `${HUB.http}/zip`;
const UPLOAD_URL = `${HUB.http}/upload`;
const CHUNK_SIZE = 8 * 1024 * 1024;          // 8 MB chunks
const CHUNK_THRESHOLD = 64 * 1024 * 1024;    // files larger than this upload resumably
const UPLOAD_CANCEL_URL = `${HUB.http}/upload/cancel`;
const GIT_URL = `${HUB.http}/git`;
const RUNNERS_DELETE_URL = `${HUB.http}/runners/delete`;
const RUNNERS_BUILD_URL = `${HUB.http}/runners/build`;
const SESSION_URL = `${HUB.http}/session`; // exchange token -> cookie

// bearer token for write endpoints; mirrored from React state into this holder
// so plain (non-component) helpers like xhrUpload can read it.
let authToken = "";
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}`, ...(extra || {}) } : { ...(extra || {}) };
}

// ── types ───────────────────────────────────────────────────────────────────
type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  sha256: string;
  size?: number;
  children?: TreeNode[];
};
type Change = {
  op: "upsert" | "delete";
  path: string;
  type?: "file" | "directory";
  sha256?: string;
  size?: number;
};
type Msg =
  | { kind: "snapshot"; version: number; tree: TreeNode }
  | { kind: "patch"; version: number; changes: Change[] }
  | { kind: "recalc"; paths: string[] }
  | { kind: "git"; id: string; phase: GitPhase; line?: string; message?: string; repo?: string; dest?: string; cmd?: string; sha?: string }
  | { kind: "runners"; runners: RunnerInfo[] }
  | { kind: "disk"; disk: { total: number; free: number; used: number; quota: boolean } };
type GitPhase = "cloning" | "building" | "copying" | "done" | "error" | "log";
type GitJob = { id: string; phase: GitPhase; dest: string; logs: string[]; error?: string };
type RunnerInfo = {
  id: string; repo: string; branch: string; dest: string;
  written: string[];
  lastSha: string | null; lastBuilt: number | null; lastChecked?: number | null;
  status: "idle" | "building" | "error"; error: string | null;
};
type Conn = "linking" | "live" | "offline";
type PendingUpload = {
  path: string; // full path relative to ROOT, as it will appear in the tree
  name: string;
  dir: string; // parent dir (cwd-relative-to-ROOT) the item lands in
  type: "file" | "directory";
  size: number;
  status: "uploading" | "processing";
};
type Toast = {
  id: number;
  label: string;
  dest?: string;
  current?: string;
  sent: number;
  total: number;
  status: "active" | "done" | "error";
  error?: string;
};

// ── page ────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [version, setVersion] = useState(0);
  const [conn, setConn] = useState<Conn>("linking");
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const [recalc, setRecalc] = useState<Set<string>>(new Set());
  const [cwd, setCwd] = useState("."); // current directory path
  const [dragOver, setDragOver] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderModal, setFolderModal] = useState(false);
  const [modalOver, setModalOver] = useState(false);
  const [gitModal, setGitModal] = useState(false);
  const [gitForm, setGitForm] = useState({ repo: "", branch: "", build: "", artifacts: "", dest: "" });
  const [gitJob, setGitJob] = useState<GitJob | null>(null);
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [disk, setDisk] = useState<{ total: number; free: number; used: number; quota: boolean } | null>(null);
  const [showAddRunner, setShowAddRunner] = useState(false);
  const [selectedRunnerId, setSelectedRunnerId] = useState<string | null>(null);
  const [collapsedRunnerGroups, setCollapsedRunnerGroups] = useState<Set<string>>(new Set());
  const [token, setToken] = useState("");
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [denied, setDenied] = useState<"ip" | "token" | null>(null);
  const [resumable, setResumable] = useState<PersistedUpload[]>([]);
  const [graphOpen, setGraphOpen] = useState(false);
  const [tokenModal, setTokenModal] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const runnerByPath = useMemo(() => {
    const m = new Map<string, RunnerInfo>();
    for (const r of runners) for (const p of r.written || []) m.set(p, r);
    return m;
  }, [runners]);
  // for each directory, how many DISTINCT runners are associated with it — by
  // their destination AND any written artifacts — plus the worst status among
  // them (error > building > idle). Drives the status-colored robot badge.
  // Using dest (not just written) means a FAILED runner with no artifacts yet
  // still shows up on its target folder.
  const runnerDirInfo = useMemo(() => {
    const byDir = new Map<string, Set<string>>(); // dirPath -> runner ids
    const statusByDir = new Map<string, "idle" | "building" | "error">();
    const rank = { idle: 0, building: 1, error: 2 } as const;
    const add = (dir: string, r: RunnerInfo) => {
      if (!dir) return;
      if (!byDir.has(dir)) byDir.set(dir, new Set());
      byDir.get(dir)!.add(r.id);
      const cur = statusByDir.get(dir);
      const st = r.status === "building" || r.status === "error" ? r.status : "idle";
      if (!cur || rank[st] > rank[cur]) statusByDir.set(dir, st);
    };
    for (const r of runners) {
      // ancestors of the destination folder
      const dest = r.dest && r.dest !== "." ? r.dest : "";
      if (dest) {
        const segs = dest.split("/");
        for (let i = 1; i <= segs.length; i++) add(segs.slice(0, i).join("/"), r);
      }
      // ancestors of each written artifact (covers nested writes)
      for (const p of r.written || []) {
        const segs = p.split("/");
        for (let i = 1; i < segs.length; i++) add(segs.slice(0, i).join("/"), r);
      }
    }
    const counts = new Map<string, number>();
    for (const [dir, ids] of byDir) counts.set(dir, ids.size);
    return { counts, statusByDir };
  }, [runners]);
  const runnerCountByDir = runnerDirInfo.counts;
  const runnerStatusByDir = runnerDirInfo.statusByDir;
  // directories that currently have a runner building inside them — the dest
  // folder and all its ancestors. Drives the spinning-gear indicator.
  const buildingDirs = useMemo(() => {
    const s = new Set<string>();
    for (const r of runners) {
      if (r.status !== "building") continue;
      const dest = r.dest && r.dest !== "." ? r.dest : "";
      if (dest) {
        const segs = dest.split("/");
        for (let i = 1; i <= segs.length; i++) s.add(segs.slice(0, i).join("/"));
      }
      // also cover ancestors of already-written artifacts (covers nested writes)
      for (const p of r.written || []) {
        const segs = p.split("/");
        for (let i = 1; i < segs.length; i++) s.add(segs.slice(0, i).join("/"));
      }
    }
    return s;
  }, [runners]);
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; name: string; type: "file" | "directory" } | null>(null);
  const [pending, setPending] = useState<Map<string, PendingUpload>>(new Map());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const recentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resumeInput = useRef<HTMLInputElement>(null);
  const resumeTarget = useRef<PersistedUpload | null>(null);
  const dragDepth = useRef(0);
  const toastId = useRef(0);
  const cwdRef = useRef(cwd);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  const runnersRef = useRef<RunnerInfo[]>([]);
  useEffect(() => { runnersRef.current = runners; }, [runners]);
  const buildToasts = useRef<Map<string, number>>(new Map()); // build id -> toast id
  const myBuilds = useRef<Set<string>>(new Set()); // build ids the user triggered (show in-modal panel)

  // load saved bearer token once; keep the module-level holder in sync so the
  // upload XHR (a plain function) can read it too
  useEffect(() => {
    try {
      const t = localStorage.getItem("onesvd_token") || "";
      if (t) {
        setToken(t); authToken = t;
        // refresh the session cookie so shared/file links keep working
        fetch(SESSION_URL, { method: "POST", credentials: "include", headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
      }
    } catch {}
    setTokenLoaded(true);
  }, []);

  // on load, surface any interrupted large uploads so they can be resumed
  useEffect(() => {
    try {
      setResumable(loadPersistedUploads().filter((u) => u.received < u.size));
    } catch {}
  }, []);
  useEffect(() => { authToken = token; }, [token]);

  const saveToken = (t: string) => {
    setToken(t);
    authToken = t;
    setDenied(null);
    try { t ? localStorage.setItem("onesvd_token", t) : localStorage.removeItem("onesvd_token"); } catch {}
    // Exchange the token for a session cookie so file/zip links (which carry no
    // token) are authorized by the browser session instead. Logout if cleared.
    if (t) {
      fetch(SESSION_URL, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${t}` },
      }).catch(() => {});
    }
  };
  const gitLogRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = gitLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [gitJob?.logs]);

  // when the real tree updates, reconcile optimistic state with reality
  useEffect(() => {
    if (!tree) return;
    // drop optimistic upload rows that now exist
    setPending((m) => {
      if (m.size === 0) return m;
      let changed = false;
      const next = new Map(m);
      for (const key of m.keys()) {
        if (pathExists(tree, key)) { next.delete(key); changed = true; }
      }
      return changed ? next : m;
    });
    // drop optimistic delete markers once the item is actually gone
    setRemoving((s) => {
      if (s.size === 0) return s;
      let changed = false;
      const next = new Set(s);
      for (const key of s) {
        if (!pathExists(tree, key)) { next.delete(key); changed = true; }
      }
      return changed ? next : s;
    });
  }, [tree]);

  useEffect(() => {
    if (!tokenLoaded) return; // wait until we know the token, so we don't flash an auth error
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      setConn((c) => (c === "live" ? "linking" : c));
      const url = authToken ? `${WS_URL}?token=${encodeURIComponent(authToken)}` : WS_URL;
      ws = new WebSocket(url);
      ws.onopen = () => { setConn("live"); setDenied(null); };
      ws.onclose = (ev) => {
        if (ev.code === 4401) { setDenied("token"); setConn("offline"); setTokenModal(true); return; } // bad/missing token — don't retry
        if (ev.code === 4403) { setDenied("ip"); setConn("offline"); return; }                          // ip blocked — don't retry
        setConn("offline");
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        const msg: Msg = JSON.parse(e.data);
        if (msg.kind === "runners") {
          setRunners(msg.runners);
          return;
        }
        if (msg.kind === "git") {
          // surface build activity globally (toast) so a poll-triggered build is
          // visible even when the Git Runners modal is closed. One toast per
          // build id, updated in place from building -> complete/failed.
          if (msg.phase === "cloning") {
            const r = runnersRef.current.find((x) => x.id === msg.id);
            const label = `Runner building${r ? ` · ${shortRepo(r.repo)}` : ""}`;
            const existing = buildToasts.current.get(msg.id);
            if (existing != null) {
              updateToast(existing, { label, status: "active", error: undefined });
            } else {
              buildToasts.current.set(msg.id, pushToast(label, "active"));
            }
          } else if (msg.phase === "done") {
            const r = runnersRef.current.find((x) => x.id === msg.id);
            const tid = buildToasts.current.get(msg.id);
            const label = `Runner build complete${r ? ` · ${shortRepo(r.repo)}` : ""}`;
            if (tid != null) { updateToast(tid, { label, status: "done" }); setTimeout(() => dismissToast(tid), 2500); buildToasts.current.delete(msg.id); }
            else pushToast(label, "done");
          } else if (msg.phase === "error") {
            const tid = buildToasts.current.get(msg.id);
            if (tid != null) { updateToast(tid, { label: "Runner build failed", status: "error", error: msg.message || undefined }); setTimeout(() => dismissToast(tid), 6000); buildToasts.current.delete(msg.id); }
            else pushToast("Runner build failed", "error", msg.message || undefined);
          }
          // The in-modal build panel (gitJob) is only for builds the user
          // triggered here (add form or Rebuild button). Background poll builds
          // are surfaced via toasts only — no lingering panel.
          if (myBuilds.current.has(msg.id)) {
            setGitJob((j) => {
              const base: GitJob = j && j.id === msg.id ? j : { id: msg.id, phase: "cloning", dest: "", logs: [], error: undefined };
              if (msg.phase === "log") return { ...base, logs: [...base.logs, msg.line || ""].slice(-400) };
              if (msg.phase === "error") return { ...base, phase: "error", error: msg.message || "failed" };
              if (msg.phase === "done") return { ...base, phase: "done", dest: msg.dest || base.dest };
              return { ...base, phase: msg.phase, dest: msg.dest || base.dest };
            });
            if (msg.phase === "done" || msg.phase === "error") {
              myBuilds.current.delete(msg.id);
              const closeId = msg.id;
              setTimeout(() => setGitJob((j) => (j && j.id === closeId ? null : j)), msg.phase === "done" ? 4000 : 8000);
            }
          }
          return;
        }
        if (msg.kind === "disk") {
          setDisk(msg.disk);
          return;
        }
        if (msg.kind === "recalc") {          // mark these paths as recalculating until the next patch lands
          setRecalc(new Set(msg.paths));
          return;
        }
        if (msg.kind === "snapshot") {
          setTree(msg.tree);
          setVersion(msg.version);
          setRecalc(new Set());
          return;
        }
        setVersion(msg.version);
        setRecalc(new Set()); // hashes have landed; clear the recalculating state
        const touched = new Set(msg.changes.map((c) => c.path).filter((p) => p !== "."));
        setRecent(touched);
        if (recentTimer.current) clearTimeout(recentTimer.current);
        recentTimer.current = setTimeout(() => setRecent(new Set()), 1400);
        setTree((prev) => (prev ? applyPatch(prev, msg.changes) : prev));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      if (recentTimer.current) clearTimeout(recentTimer.current);
      ws?.close();
    };
  }, [tokenLoaded, token]);

  // if the current directory disappears (deleted), walk up to the nearest one
  useEffect(() => {
    if (!tree || cwd === "." || nodeAt(tree, cwd)) return;
    let p = cwd;
    while (p !== "." && !nodeAt(tree, p)) {
      const i = p.lastIndexOf("/");
      p = i === -1 ? "." : p.slice(0, i);
    }
    setCwd(p);
  }, [tree, cwd]);

  // close any open modal on Escape
  useEffect(() => {
    if (!folderModal && !confirmDelete && !gitModal && !tokenModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFolderModal(false);
        setConfirmDelete(null);
        setGitModal(false);
        setTokenModal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folderModal, confirmDelete, gitModal, tokenModal, gitJob]);

  const current = tree ? nodeAt(tree, cwd) : null;
  const items = useMemo(() => {
    const c = current?.children ?? [];
    const real = [...c]
      .filter((n) => !removing.has(n.path))
      .sort((a, b) =>
        a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)
      );
    // optimistic rows for items landing directly in the current dir
    const existing = new Set(real.map((n) => n.name));
    const ghosts: TreeNode[] = [];
    for (const p of pending.values()) {
      if (p.dir !== cwd || existing.has(p.name)) continue;
      ghosts.push({ name: p.name, path: p.path, type: p.type, sha256: "", size: p.size, children: p.type === "directory" ? [] : undefined });
      existing.add(p.name);
    }
    ghosts.sort((a, b) =>
      a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)
    );
    return [...real, ...ghosts];
  }, [current, pending, cwd, removing]);

  const folderBytes = useMemo(() => (current ? count(current).bytes : 0), [current]);

  const crumbs =
    cwd === "."
      ? []
      : cwd.split("/").map((seg, i, arr) => {
          const path = arr.slice(0, i + 1).join("/");
          const node = tree ? nodeAt(tree, path) : null;
          return { name: seg, path, sha256: node?.sha256 || "" };
        });

  const updateToast = (id: number, patch: Partial<Toast>) =>
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const dismissToast = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  // one-shot message toast (delete / copy feedback)
  const pushToast = (label: string, status: "active" | "done" | "error", error?: string) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, label, sent: 1, total: 1, status, error }]);
    // active toasts persist (until updated/dismissed); done/error auto-dismiss
    if (status !== "active") setTimeout(() => dismissToast(id), status === "error" ? 6000 : 2500);
    return id;
  };

  const submitGit = async () => {
    const repo = gitForm.repo.trim();
    if (!repo) return;
    const dest = cwdRef.current === "." ? "" : cwdRef.current; // build into the folder we're viewing
    const branch = gitForm.branch.trim();
    setGitJob({ id: "pending", phase: "cloning", dest: "", logs: [], error: undefined });
    try {
      const res = await fetch(GIT_URL, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ repo, dest: dest || undefined, branch: branch || undefined }),
      });
      if (res.status === 401) { setGitJob(null); setTokenModal(true); return; }
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const { id } = await res.json();
      myBuilds.current.add(id); // user-triggered: show the in-modal build panel
      setGitJob({ id, phase: "cloning", dest: "", logs: [], error: undefined });
      setGitForm({ repo: "", branch: "", build: "", artifacts: "", dest: "" });
      setShowAddRunner(false);
    } catch (e: any) {
      setGitJob({ id: "pending", phase: "error", dest: "", logs: [], error: e?.message || String(e) });
    }
  };

  const removeRunner = async (id: string) => {
    setRunners((rs) => rs.filter((r) => r.id !== id)); // optimistic
    try {
      await fetch(`${RUNNERS_DELETE_URL}?id=${encodeURIComponent(id)}`, { method: "POST", headers: authHeaders() });
    } catch {
      /* the next runners broadcast will reconcile */
    }
  };

  const rebuildRunner = async (id: string) => {
    try {
      myBuilds.current.add(id); // user-triggered: show the in-modal build panel
      setGitJob({ id, phase: "cloning", dest: "", logs: [], error: undefined });
      const res = await fetch(`${RUNNERS_BUILD_URL}?id=${encodeURIComponent(id)}`, { method: "POST", headers: authHeaders() });
      if (res.status === 401) { myBuilds.current.delete(id); setGitJob(null); setTokenModal(true); return; }
      if (res.status === 409) { myBuilds.current.delete(id); setGitJob(null); pushToast("Already building", "done"); return; }
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      // build progress + completion arrive over WS (panel + toasts)
    } catch (e: any) {
      myBuilds.current.delete(id);
      setGitJob(null);
      pushToast("Couldn't start build", "error", e?.message || String(e));
    }
  };

  // open the Git Runners modal to a specific tab / selection. focusDir collapses
  // every runner group except the one for that top-level directory — unless that
  // group has exactly one runner, in which case we just select it directly.
  const openRunners = (opts?: { add?: boolean; selectId?: string | null; focusDir?: string }) => {
    if (opts?.add) {
      setShowAddRunner(true);
      setSelectedRunnerId(null);
    } else {
      setShowAddRunner(false);
      if (opts?.focusDir !== undefined) {
        const focusKey = opts.focusDir ? opts.focusDir.split("/")[0] : "\u0000root";
        const inGroup = runnersRef.current.filter((r) => {
          const top = r.dest && r.dest !== "." ? r.dest.split("/")[0] : "";
          return (top || "\u0000root") === focusKey;
        });
        // collapse every group except the focused one, regardless of count
        const others = new Set<string>();
        for (const r of runnersRef.current) {
          const top = r.dest && r.dest !== "." ? r.dest.split("/")[0] : "";
          const key = top || "\u0000root";
          if (key !== focusKey) others.add(key);
        }
        setCollapsedRunnerGroups(others);
        // if there's only one runner here, also select it directly (like its artifact)
        setSelectedRunnerId(inGroup.length === 1 ? inGroup[0].id : null);
      } else {
        const sel = opts?.selectId ?? null;
        setSelectedRunnerId(sel);
        // focus the selected runner's group: collapse all others, expand its own
        if (sel) {
          const r = runnersRef.current.find((x) => x.id === sel);
          const focusKey = r && r.dest && r.dest !== "." ? r.dest.split("/")[0] : "\u0000root";
          const others = new Set<string>();
          for (const x of runnersRef.current) {
            const top = x.dest && x.dest !== "." ? x.dest.split("/")[0] : "";
            const key = top || "\u0000root";
            if (key !== focusKey) others.add(key);
          }
          setCollapsedRunnerGroups(others);
        }
      }
    }
    setGitModal(true);
  };

  const copyTextToClipboard = async (text: string): Promise<boolean> => {
    // modern API (secure contexts)
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }
    // legacy fallback: hidden textarea + execCommand("copy")
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const copyLink = async (relPath: string) => {
    const url = viewUrl(relPath);
    const ok = await copyTextToClipboard(url);
    pushToast(ok ? "Link copied" : "Couldn't copy link", ok ? "done" : "error");
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const { path, name } = confirmDelete;
    setConfirmDelete(null);
    // optimistic: hide the row right away
    setRemoving((s) => new Set(s).add(path));
    const restore = () => setRemoving((s) => { const n = new Set(s); n.delete(path); return n; });
    try {
      const res = await fetch(`${DELETE_URL}?path=${encodeURIComponent(path)}`, { method: "POST", headers: authHeaders() });
      if (res.status === 401) { restore(); setTokenModal(true); pushToast("Auth required to delete", "error"); return; }
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      pushToast(`Deleted ${name}`, "done");
      // safety net: if no patch confirms the removal, stop hiding it
      setTimeout(restore, 15000);
    } catch (e: any) {
      restore(); // bring the row back — delete didn't happen
      pushToast(`Delete failed: ${name}`, "error", e?.message || String(e));
    }
  };

  // Build a CSV of a folder's full (recursive) structure: path, type, hash, size.
  // For files that a git runner produced, include the repo + the commit they were
  // built from + when. Generated entirely client-side from the live tree.
  const exportFolderCsv = (root: TreeNode) => {
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows: string[] = [];
    // parent directory summary block at the top
    rows.push(["directory", esc(root.name || "root")].join(","));
    rows.push(["hash", esc(root.sha256 || "")].join(","));
    rows.push(["zip", esc(zipUrl(root.path))].join(","));
    rows.push(""); // blank separator
    // table: name first, download url last, no type column
    const header = ["name", "sha256", "runner_repo", "runner_commit", "runner_built_at", "url"];
    rows.push(header.join(","));
    const walk = (node: TreeNode) => {
      if (node.type === "directory") {
        // directory acts as a section header: only its path, everything else blank
        rows.push([esc(node.path), "", "", "", "", ""].join(","));
      } else {
        const r = runnerByPath.get(node.path);
        rows.push([
          esc(node.name),
          esc(node.sha256 || ""),
          esc(r ? r.repo : ""),
          esc(r && r.lastSha ? r.lastSha : ""),
          esc(r && r.lastBuilt ? new Date(r.lastBuilt).toISOString() : ""),
          esc(viewUrl(node.path)),
        ].join(","));
      }
      if (node.children) {
        // files first (listed directly under this directory's header), then
        // subdirectories last (each becomes its own header + files below it)
        const kids = [...node.children].sort(
          (a, b) => (a.type !== b.type ? (a.type === "file" ? -1 : 1) : a.name.localeCompare(b.name))
        );
        for (const c of kids) walk(c);
      }
    };
    walk(root);
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${root.name || "root"}-structure.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast(`Exported ${root.name || "root"} structure`, "done");
  };

  const renderActions = (node: TreeNode) => (
    <span className="col-act actions">
      <button
        className="act-btn act-danger"
        title={`Delete ${node.type === "directory" ? "folder" : "file"}`}
        aria-label={`Delete ${node.name}`}
        onClick={() => setConfirmDelete({ path: node.path, name: node.name, type: node.type })}
      >
        {Trash}
      </button>
      <button className="act-btn" title="Copy link" aria-label={`Copy link to ${node.name}`} onClick={() => copyLink(node.path)}>
        {LinkIcon}
      </button>
      <a
        className="act-btn"
        href={node.type === "file" ? downloadUrl(node.path) : zipUrl(node.path)}
        title={node.type === "file" ? "Download" : "Download as zip"}
        aria-label={node.type === "file" ? `Download ${node.name}` : `Download ${node.name} as zip`}
      >
        {Download}
      </a>
      {cwd === "." && node.type === "directory" && (
        <button
          className="act-btn"
          title="Export structure as CSV"
          aria-label={`Export ${node.name} structure as CSV`}
          onClick={() => exportFolderCsv(node)}
        >
          {CsvIcon}
        </button>
      )}
    </span>
  );

  // Upload {file, relPath} entries. Large single files go through the resumable
  // chunked path (one at a time); everything else uses the batched multipart path.
  const uploadList = async (entries: { file: File; relPath: string }[]) => {
    if (!entries.length) return;
    const large = entries.filter((e) => e.file.size > CHUNK_THRESHOLD);
    const small = entries.filter((e) => e.file.size <= CHUNK_THRESHOLD);
    if (small.length) await uploadSmall(small);
    for (const e of large) await uploadLargeFile(e); // sequential (concurrency 1)
  };

  // discard an interrupted upload: forget it locally and delete the server partial
  const cancelResumable = (u: PersistedUpload) => {
    setResumable((r) => r.filter((x) => x.id !== u.id));
    clearPersistedUpload(u.id);
    fetch(`${UPLOAD_CANCEL_URL}?id=${encodeURIComponent(u.id)}`, { method: "POST", headers: authHeaders() }).catch(() => {});
  };
  const cancelAllResumable = () => {
    for (const u of resumable) cancelResumable(u);
  };

  // open the file picker for one specific interrupted upload
  const pickResume = (u: PersistedUpload) => {
    resumeTarget.current = u;
    resumeInput.current?.click();
  };
  // resume a specific upload to its ORIGINAL folder (not the current dir)
  const resumeUpload = (target: PersistedUpload, file: File) => {
    if (file.name !== target.name || file.size !== target.size) {
      pushToast(`That isn't ${target.name}`, "error", "pick the same file (name and size must match)");
      return;
    }
    uploadLargeFile({ file, relPath: "" }, target.dir);
  };

  // resumable chunked upload for one large file, with its own toast + ghost row.
  // destOverride forces the destination dir (used when resuming to its original folder).
  const uploadLargeFile = async ({ file, relPath }: { file: File; relPath: string }, destOverride?: string) => {
    const baseCwd = cwdRef.current;
    const dir = destOverride ?? joinDir(baseCwd, relPath);
    const useGhost = destOverride === undefined; // only show a ghost when uploading into the current view
    const seg = relPath.split("/").filter(Boolean)[0];
    const ghostPath = seg ? treeJoin(baseCwd, seg) : treeJoin(dir, file.name);
    const ghost: PendingUpload = seg
      ? { path: ghostPath, name: seg, dir: baseCwd, type: "directory", size: 0, status: "uploading" }
      : { path: ghostPath, name: file.name, dir, type: "file", size: file.size, status: "uploading" };
    if (useGhost) setPending((m) => new Map(m).set(ghostPath, ghost));
    const clearGhost = () => { if (useGhost) setPending((m) => { const n = new Map(m); n.delete(ghostPath); return n; }); };

    const destLabel = dir === "." ? "/" : "/" + dir;
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, label: file.name, dest: destLabel, sent: 0, total: file.size, status: "active", current: "starting…" }]);
    // this file→dir is now being uploaded — drop it from the resume list
    setResumable((r) => r.filter((u) => !(u.name === file.name && u.size === file.size && u.dir === dir)));
    try {
      await chunkedUpload(file, dir, (sent, retrying) => {
        updateToast(id, { sent, current: retrying ? "reconnecting…" : `${pct(sent, file.size)}%` });
      });
      if (useGhost) setPending((m) => { const n = new Map(m); const cur = n.get(ghostPath); if (cur) n.set(ghostPath, { ...cur, status: "processing" }); return n; });
      updateToast(id, { sent: file.size, status: "done", current: undefined });
      setTimeout(() => dismissToast(id), 3500);
      setTimeout(clearGhost, 20000); // safety net; the tree patch normally clears it
    } catch (e: any) {
      const auth = e?.message === "AUTH" || e?.auth;
      updateToast(id, { status: "error", error: auth ? "auth required" : e?.message || String(e) });
      setTimeout(() => dismissToast(id), 8000);
      clearGhost();
      if (auth) setTokenModal(true);
    }
  };

  // batched multipart upload for small files (and folder trees), with one toast
  const uploadSmall = async (entries: { file: File; relPath: string }[]) => {
    if (!entries.length) return;
    const id = ++toastId.current;
    const total = entries.reduce((s, e) => s + (e.file.size || 0), 0);
    const label = entries.length === 1 ? entries[0].file.name : `${entries.length} files`;
    setToasts((ts) => [...ts, { id, label, sent: 0, total, status: "active" }]);

    // optimistic rows: one per item that will appear directly under a dir.
    // A file dropped into dir D shows as a file row in D; a file nested deeper
    // surfaces the top-level new folder under D as a directory row.
    const baseCwd = cwdRef.current;
    const baseDir = (relPath: string) => joinDir(baseCwd, relPath);
    const optimistic = new Map<string, PendingUpload>();
    for (const { file, relPath } of entries) {
      const dir = baseDir(relPath);
      const seg = relPath.split("/").filter(Boolean)[0];
      if (!seg) {
        const p = treeJoin(dir, file.name);
        optimistic.set(p, { path: p, name: file.name, dir, type: "file", size: file.size || 0, status: "uploading" });
      } else {
        const folderPath = treeJoin(baseCwd, seg);
        if (!optimistic.has(folderPath)) {
          optimistic.set(folderPath, { path: folderPath, name: seg, dir: baseCwd, type: "directory", size: 0, status: "uploading" });
        }
      }
    }
    setPending((m) => { const next = new Map(m); for (const [k, v] of optimistic) next.set(k, v); return next; });
    const clearOptimistic = () =>
      setPending((m) => { const next = new Map(m); for (const k of optimistic.keys()) next.delete(k); return next; });
    const markProcessing = (dir: string) =>
      setPending((m) => {
        const next = new Map(m);
        for (const [k, v] of optimistic) if (v.dir === dir || k.startsWith(dir + "/") || dir.startsWith(v.path)) {
          const cur = next.get(k);
          if (cur) next.set(k, { ...cur, status: "processing" });
        }
        return next;
      });

    try {
      const groups = new Map<string, File[]>();
      for (const { file, relPath } of entries) {
        const dir = joinDir(baseCwd, relPath);
        let arr = groups.get(dir);
        if (!arr) { arr = []; groups.set(dir, arr); }
        arr.push(file);
      }
      let base = 0; // bytes fully sent in completed groups
      for (const [dir, files] of groups) {
        const fd = new FormData();
        for (const f of files) fd.append("files", f);
        updateToast(id, { dest: dir === "." ? "/" : "/" + dir, current: files.length === 1 ? files[0].name : `${files.length} files → ${dir === "." ? "/" : dir}` });
        const url = dir === "." ? UPLOAD_URL : `${UPLOAD_URL}?dir=${encodeURIComponent(dir)}`;
        await xhrUpload(url, fd, (loaded) => updateToast(id, { sent: Math.min(total, base + loaded) }));
        base += files.reduce((s, f) => s + (f.size || 0), 0);
        markProcessing(dir);
      }
      updateToast(id, { sent: total, status: "done", current: undefined });
      setTimeout(() => dismissToast(id), 3500);
      // safety net: clear any leftover optimistic rows if no patch arrives
      setTimeout(clearOptimistic, 15000);
    } catch (e: any) {
      const auth = e?.message === "AUTH";
      updateToast(id, { status: "error", error: auth ? "auth required" : e?.message || String(e) });
      setTimeout(() => dismissToast(id), 7000);
      clearOptimistic();
      if (auth) setTokenModal(true);
    }
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) uploadList(Array.from(files).map((f) => ({ file: f, relPath: "" })));
    e.target.value = "";
  };

  // grab dropped entries synchronously (before the event is recycled)
  const collectDrop = (dt: DataTransfer | null) => {
    const roots: any[] = [];
    if (dt?.items?.length && (dt.items[0] as any).webkitGetAsEntry) {
      for (const it of Array.from(dt.items)) {
        const entry = (it as any).webkitGetAsEntry?.();
        if (entry) roots.push(entry);
      }
    }
    const flat = dt?.files?.length ? Array.from(dt.files) : [];
    return { roots, flat };
  };

  const processDrop = async (roots: any[], flat: File[]) => {
    let entries: { file: File; relPath: string }[] = [];
    if (roots.length) {
      for (const entry of roots) entries.push(...(await walkEntry(entry, "")));
    } else if (flat.length) {
      entries = flat.map((f) => ({ file: f, relPath: "" }));
    }
    if (entries.length) uploadList(entries);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const { roots, flat } = collectDrop(e.dataTransfer);
    processDrop(roots, flat);
  };

  const onModalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setModalOver(false);
    const { roots, flat } = collectDrop(e.dataTransfer);
    setFolderModal(false);
    processDrop(roots, flat);
  };

  const dragProps = {
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); dragDepth.current++; setDragOver(true); },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false); },
    onDrop,
  };

  const targetLabel = cwd === "." ? "/" : `/${cwd}`;

  return (
    <div className="svd">
      <style>{CSS}</style>

      <nav className="nav">
        <button className="brand" onClick={() => setCwd(".")} aria-label="OneSVD — home">
          <span className="word">One<span className="word-accent">SVD</span></span>
        </button>

        {tree && current && cwd !== "." && (
          <nav className="crumbs" aria-label="Location">
            {crumbs.map((c, i) => (
              <span className="crumb-wrap" key={c.path}>
                {i > 0 && <span className="sep" aria-hidden>{Chevron}</span>}
                <button
                  className={`crumb${i === 0 ? " is-first" : ""}${i === crumbs.length - 1 ? " is-current" : ""}`}
                  onClick={() => setCwd(c.path)}
                  title={i === 0 && c.sha256 ? `${c.name} — ${c.sha256}` : c.name}
                >
                  <span className="crumb-name">{c.name}</span>
                  {i === 0 && c.sha256 && <span className="crumb-hash">{shortHash(c.sha256)}</span>}
                </button>
              </span>
            ))}
          </nav>
        )}

        <div className="nav-right">
          {tree && (
            <button
              className="fingerprint"
              key={version}
              onClick={() => setGraphOpen(true)}
              title={`root ${tree.sha256} — click to view the Merkle graph`}
            >
              <span className="fp-dot" aria-hidden />
              <span className="fp-label">root</span>
              <span className="fp-hash">
                {recalc.has(".") ? "recalculating" : shortHash(tree.sha256)}
              </span>
            </button>
          )}
        </div>
      </nav>

      {denied && (
        <div className={`authbanner authbanner--${denied}`} role="alert">
          {denied === "ip" ? (
            <span>Access blocked — your IP isn’t on the server’s allowlist.</span>
          ) : (
            <span>Auth required — set the access token to connect.</span>
          )}
          {denied === "token" && (
            <button className="authbanner-btn" onClick={() => { setTokenDraft(token); setTokenModal(true); }}>
              {KeyIcon} Set token
            </button>
          )}
        </div>
      )}



      {tree && current ? (
        <main className="explorer" {...dragProps}>
          <div className="colhead">
            <span>Name</span>
            <span className="col-size">Size</span>
            <span className="col-hash">Hash</span>
            <span className="col-act" />
          </div>

          <div className="rows" role="list">
            {items.length === 0 ? (
              <div className="folder-empty">This folder is empty.</div>
            ) : (
              items.map((node) => {
                const p = pending.get(node.path);
                const isGhost = !!p && node.sha256 === "";
                if (node.type === "directory") {
                  const runner = runnerByPath.get(node.path);
                  const innerRunners = runner ? 0 : (runnerCountByDir.get(node.path) || 0);
                  const building = buildingDirs.has(node.path);
                  return (
                    <div
                      key={node.path}
                      className={`row row--dir${runner ? " row--runner" : ""}${recent.has(node.path) ? " is-flash" : ""}${isGhost ? " is-ghost" : ""}`}
                      role="listitem"
                    >
                      {isGhost ? (
                        <span className="cell-name">
                          <span className={`ic ${runner ? "ic--runner" : "ic--folder"}`} aria-hidden>{runner ? GitIcon : Folder}</span>
                          <span className="nm">{node.name}</span>
                        </span>
                      ) : (
                        <button className="cell-name folder-link" onClick={() => setCwd(node.path)} title={`Open ${node.name}`}>
                          <span className={`ic ${runner ? "ic--runner" : "ic--folder"}`} aria-hidden>{runner ? GitIcon : Folder}</span>
                          <span className="nm">{node.name}</span>
                          {building && (
                            <span className="gear-spin" title="A runner is building here" aria-label="building">{Gear}</span>
                          )}
                          {innerRunners > 0 && (() => {
                            const dirStatus = runnerStatusByDir.get(node.path) || "idle";
                            const statusWord = dirStatus === "error" ? "failed" : dirStatus === "building" ? "building" : "idle";
                            return (
                              <span
                                className={`runner-dot runner-dot--${dirStatus}`}
                                role="button"
                                tabIndex={0}
                                title={`${innerRunners} runner${innerRunners === 1 ? "" : "s"} inside · ${statusWord} — view`}
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); openRunners({ focusDir: node.path }); }}
                              >
                                {RobotIcon}
                                <span className="runner-dot-n">{innerRunners}</span>
                              </span>
                            );
                          })()}
                          {runner && (
                            <span
                              className={`runner-badge runner-badge--${runner.status}`}
                              role="button"
                              tabIndex={0}
                              title={`Git runner · ${shortRepo(runner.repo)}${runner.lastSha ? ` · ${runner.lastSha.slice(0, 7)}` : ""}`}
                              onClick={(e) => { e.stopPropagation(); e.preventDefault(); openRunners({ selectId: runner.id }); }}
                            >
                              {runner.status === "building" ? <span className="recalc-spin" /> : GitIcon}
                              <span className="runner-badge-txt">{runner.status === "building" ? "building" : "runner"}</span>
                            </span>
                          )}
                        </button>
                      )}
                      <span className="col-size meta">
                        {isGhost ? "" : `${node.children?.length ?? 0} ${(node.children?.length ?? 0) === 1 ? "item" : "items"}`}
                      </span>
                      {isGhost ? (
                        <span className="col-hash hash recalc"><span className="recalc-spin" />{p!.status === "uploading" ? "uploading" : "processing"}</span>
                      ) : recalc.has(node.path) ? (
                        <span className="col-hash hash recalc"><span className="recalc-spin" />recalculating</span>
                      ) : (
                        <code className="col-hash hash">{shortHash(node.sha256)}</code>
                      )}
                      {isGhost ? <span className="col-act" /> : renderActions(node)}
                    </div>
                  );
                }
                const fileRunner = runnerByPath.get(node.path);
                return (
                  <div
                    key={node.path}
                    className={`row row--file${fileRunner ? " row--runner" : ""}${recent.has(node.path) ? " is-flash" : ""}${isGhost ? " is-ghost" : ""}`}
                    role="listitem"
                  >
                    {isGhost ? (
                      <span className="cell-name">
                        <span className={`ic ${fileRunner ? "ic--runner" : "ic--file"}`} aria-hidden>{fileRunner ? GitIcon : File}</span>
                        <span className="nm">{node.name}</span>
                      </span>
                    ) : (
                      <a
                        className="cell-name file-link"
                        href={viewUrl(node.path)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`View ${node.name}`}
                      >
                        <span className={`ic ${fileRunner ? "ic--runner" : "ic--file"}`} aria-hidden>{fileRunner ? GitIcon : File}</span>
                        <span className="nm">{node.name}</span>
                        {fileRunner && (
                          <span
                            className={`runner-badge runner-badge--${fileRunner.status}`}
                            role="button"
                            tabIndex={0}
                            title={`Git artifact · ${shortRepo(fileRunner.repo)}${fileRunner.lastSha ? ` · ${fileRunner.lastSha.slice(0, 7)}` : ""}`}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); openRunners({ selectId: fileRunner.id }); }}
                          >
                            {fileRunner.status === "building" ? <span className="recalc-spin" /> : GitIcon}
                            <span className="runner-badge-txt">artifact</span>
                          </span>
                        )}
                      </a>
                    )}
                    <span className="col-size meta">{formatBytes(node.size ?? 0)}</span>
                    {isGhost ? (
                      <span className="col-hash hash recalc"><span className="recalc-spin" />{p!.status === "uploading" ? "uploading" : "processing"}</span>
                    ) : recalc.has(node.path) ? (
                      <span className="col-hash hash recalc"><span className="recalc-spin" />recalculating</span>
                    ) : (
                      <code className="col-hash hash">{shortHash(node.sha256)}</code>
                    )}
                    {isGhost ? <span className="col-act" /> : renderActions(node)}
                  </div>
                );
              })
            )}
          </div>

          <div className="statusbar">
            <span>{items.length} {items.length === 1 ? "item" : "items"} · {formatBytes(folderBytes)}</span>
            {disk && (() => {
              const pct = disk.total > 0 ? Math.min(100, Math.round((disk.used / disk.total) * 100)) : 0;
              const low = disk.total > 0 && disk.free / disk.total < 0.1; // <10% free
              return (
                <span className={`sb-disk${low ? " is-low" : ""}`} tabIndex={0}>
                  <span className="sb-disk-chip" aria-label={`Storage ${pct}% used`}>
                    {Disk}<span className="sb-disk-pct">{pct}%</span>
                  </span>
                  <span className="sb-disk-pop" role="tooltip">
                    <span className="sb-pop-row"><span className="sb-pop-k">{disk.quota ? "Plan" : "Disk"}</span><span className="sb-pop-v">{formatBytes(disk.total)}</span></span>
                    <span className="sb-pop-row"><span className="sb-pop-k">Used</span><span className="sb-pop-v">{formatBytes(disk.used)} · {pct}%</span></span>
                    <span className="sb-pop-row"><span className="sb-pop-k">Free</span><span className="sb-pop-v">{formatBytes(disk.free)}</span></span>
                    <span className="sb-bar" aria-hidden><span className="sb-bar-fill" style={{ width: `${pct}%` }} /></span>
                  </span>
                </span>
              );
            })()}
            <span className="sb-version">OneSVD v{APP_VERSION} · {BUILD_HASH}</span>
          </div>

          {dragOver && (
            <div className="dropzone" aria-hidden>
              <div className="dropzone-inner">
                {Upload}
                <span>Drop files or folders to upload to <code>{targetLabel}</code></span>
              </div>
            </div>
          )}
        </main>
      ) : (
        <main className="explorer">
          <div className="empty">
            <div className="empty-glyph" aria-hidden>{DiamondLg}</div>
            <p className="empty-title">
              {conn === "offline" ? "Reconnecting to the tree" : "Waiting for the first snapshot"}
            </p>
            <p className="empty-sub">
              {conn === "offline"
                ? "The hub went quiet. Holding the line and retrying."
                : "Connected — the watcher hasn't published yet. Is it running?"}
            </p>
          </div>
        </main>
      )}

      {(toasts.length > 0 || resumable.length > 0) && (
        <div className={`bl-stack${graphOpen ? " bl-stack--graph" : ""}`}>
          {toasts.length > 0 && (
            <div className="toasts">
              {toasts.map((t) => (
                <div key={t.id} className={`toast toast--${t.status}`}>
                  <div className="toast-head">
                    <span className="toast-ic">
                      {t.status === "done" ? Check : t.status === "error" ? Cross : <span className="spinner" />}
                    </span>
                    <span className="toast-label" title={t.label}>{t.label}</span>
                    <span className="toast-pct">
                      {t.status === "done" ? "Done" : t.status === "error" ? "Failed" : `${pct(t.sent, t.total)}%`}
                    </span>
                  </div>
                  {t.dest && <div className="toast-dest" title={t.dest}>→ {t.dest}</div>}
                  {t.status === "active" && (
                    <>
                      {t.current && <div className="toast-current" title={t.current}>{t.current}</div>}
                      <div className="toast-track">
                        <div className="toast-fill" style={{ width: `${pct(t.sent, t.total)}%` }} />
                      </div>
                    </>
                  )}
                  {t.status === "error" && t.error && <div className="toast-err">{t.error}</div>}
                </div>
              ))}
            </div>
          )}

          {resumable.length > 0 && (
            <div className="resumebar" role="status">
              <div className="resumebar-hd">
                <span className="resumebar-ic" aria-hidden>{Upload}</span>
                <span>{resumable.length === 1 ? "Interrupted upload" : `${resumable.length} interrupted uploads`}</span>
                {resumable.length > 1 && (
                  <button className="resumebar-cancelall" onClick={cancelAllResumable}>Cancel all</button>
                )}
              </div>
              <div className="resumebar-list">
                {resumable.map((u) => (
                  <div key={u.id} className="resumebar-item">
                    <div className="resumebar-info">
                      <span className="resumebar-name" title={u.name}>{u.name}</span>
                      <span className="resumebar-meta">→ {u.dir === "." ? "/" : "/" + u.dir} · {pct(u.received, u.size)}%</span>
                    </div>
                    <div className="resumebar-itemact">
                      <button className="resumebar-btn" onClick={() => pickResume(u)}>Resume</button>
                      <button className="resumebar-cancel" onClick={() => cancelResumable(u)} title="Discard this upload">{Cross}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tree && current && (
        <div className={`fab-wrap${menuOpen ? " is-open" : ""}`}>
          {menuOpen && <div className="fab-scrim" onClick={() => setMenuOpen(false)} />}

          <div className="fab-actions">
            <button
              className="fab-action"
              onClick={() => { setMenuOpen(false); openRunners({ add: true }); }}
            >
              <span className="fab-action-label">Git Runners</span>
              <span className="fab-action-btn">{GitIcon}</span>
            </button>
            <button
              className="fab-action"
              onClick={() => { setMenuOpen(false); setFolderModal(true); }}
            >
              <span className="fab-action-label">Upload folder</span>
              <span className="fab-action-btn">{Folder}</span>
            </button>
            <button
              className="fab-action"
              onClick={() => { setMenuOpen(false); fileInput.current?.click(); }}
            >
              <span className="fab-action-label">Upload files</span>
              <span className="fab-action-btn">{Upload}</span>
            </button>
          </div>

          <button
            className="fab"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Upload"
            aria-expanded={menuOpen}
            title={`Upload to ${targetLabel}`}
          >
            <span className="fab-plus" aria-hidden>{Plus}</span>
          </button>

          <input ref={fileInput} type="file" multiple hidden onChange={onPickFiles} />
          <input
            ref={resumeInput}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              const target = resumeTarget.current;
              e.target.value = "";
              resumeTarget.current = null;
              if (f && target) resumeUpload(target, f);
            }}
          />
        </div>
      )}

      {folderModal && (
        <div className="modal-backdrop" onClick={() => setFolderModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <span className="modal-title">Upload folder</span>
              <button className="modal-close" onClick={() => setFolderModal(false)} aria-label="Close">{Cross}</button>
            </div>
            <div
              className={`modal-drop${modalOver ? " is-over" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setModalOver(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setModalOver(false)}
              onDrop={onModalDrop}
            >
              <span className="modal-drop-ic" aria-hidden>{Folder}</span>
              <span className="modal-drop-title">Drag a folder here</span>
              <span className="modal-drop-sub">
                Uploads to <code>{targetLabel}</code>, keeping its structure
              </span>
            </div>
          </div>
        </div>
      )}

      {graphOpen && tree && (
        <div className="modal-backdrop modal-backdrop--graph" onClick={() => setGraphOpen(false)}>
          <div className="modal modal--graph" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <MerkleGraph
              tree={tree}
              version={version}
              removing={removing}
              onCopy={async (h) => { const ok = await copyTextToClipboard(h); pushToast(ok ? "Hash copied" : "Couldn't copy hash", ok ? "done" : "error"); }}
              onCopyRoot={async () => { const ok = await copyTextToClipboard(tree.sha256); pushToast(ok ? "Root hash copied" : "Couldn't copy hash", ok ? "done" : "error"); }}
              onClose={() => setGraphOpen(false)}
              onCopyLink={(p) => copyLink(p)}
              onDownload={(node) => { window.location.href = node.type === "file" ? downloadUrl(node.path) : zipUrl(node.path); }}
              onDelete={(node) => setConfirmDelete({ path: node.path, name: node.name, type: node.type })}
            />
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <span className="modal-title">Delete {confirmDelete.type === "directory" ? "folder" : "file"}</span>
              <button className="modal-close" onClick={() => setConfirmDelete(null)} aria-label="Close">{Cross}</button>
            </div>
            <p className="modal-text">
              Delete <strong>{confirmDelete.name}</strong>
              {confirmDelete.type === "directory" ? " and everything inside it" : ""}? This can't be undone.
            </p>
            <div className="modal-actions">
              <button className="mbtn mbtn--ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="mbtn mbtn--danger" onClick={doDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {gitModal && (() => {
        const selected = runners.find((r) => r.id === selectedRunnerId) || null;
        return (
        <div className="modal-backdrop" onClick={() => setGitModal(false)}>
          <div className="modal modal--git" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <span className="modal-title"><span className="modal-title-ic">{GitIcon}</span> Git Runners</span>
              <button className="modal-close" onClick={() => setGitModal(false)} aria-label="Close">{Cross}</button>
            </div>

            <div className="gtabs">
              <button
                className={`gtab${showAddRunner ? " is-active" : ""}`}
                onClick={() => { setShowAddRunner(true); setSelectedRunnerId(null); }}
              >
                <span className="gtab-plus">{Plus}</span> Add runner
              </button>
              <button
                className={`gtab${!showAddRunner ? " is-active" : ""}`}
                onClick={() => setShowAddRunner(false)}
              >
                Manage{runners.length ? ` (${runners.length})` : ""}
              </button>
            </div>

            {showAddRunner ? (
              /* ADD MODE — single focused task */
              <div className="gaddpane">
                <p className="gadd-intro">
                  Auto-clone &amp; build a repo over SSH on every commit (polled), dropping artifacts into the
                  watched tree. Configure the build with a <code>.onesvd.yml</code> at the repo root.
                </p>
                <div className="gform">
                  <label className="gfield">
                    <span className="glabel">Repository (SSH URL)</span>
                    <input className="ginput mono" type="text" placeholder="git@github.com:owner/repo.git" autoFocus
                      value={gitForm.repo} onChange={(e) => setGitForm((f) => ({ ...f, repo: e.target.value }))} />
                  </label>
                  <label className="gfield">
                    <span className="glabel">Branch <em>optional</em></span>
                    <input className="ginput mono" type="text" placeholder="default branch"
                      value={gitForm.branch} onChange={(e) => setGitForm((f) => ({ ...f, branch: e.target.value }))} />
                  </label>
                  <p className="gform-note">
                    Builds into <code>{cwd === "." ? "/ (root)" : "/" + cwd}</code> — your current folder.
                    Leave branch blank to track the repo's default. Build command and artifacts come from
                    <code>.onesvd.yml</code> at the repo root. A branch in <code>.onesvd.yml</code> overrides this.
                  </p>
                  <div className="modal-actions">
                    <button className="mbtn mbtn--ghost" onClick={() => setShowAddRunner(false)}>Cancel</button>
                    <button className="mbtn mbtn--go" disabled={!gitForm.repo.trim()} onClick={submitGit}>Add &amp; build</button>
                  </div>
                </div>
              </div>
            ) : runners.length === 0 ? (
              /* MANAGE MODE, but nothing to manage yet */
              <div className="gmanage-empty">
                <p className="modal-text">No runners yet.</p>
                <button className="mbtn mbtn--go" onClick={() => { setShowAddRunner(true); setSelectedRunnerId(null); }}>
                  <span className="radd-plus">{Plus}</span> Add your first runner
                </button>
              </div>
            ) : (
              /* MANAGE MODE — list + detail */
              <div className="gsplit">
                {/* master: runners grouped by their top-level destination folder */}
                <div className="gmaster">
                  <div className="gmaster-list">
                    {(() => {
                      // group by top-level destination dir ("/ (root)" for root dest)
                      const groups = new Map<string, RunnerInfo[]>();
                      for (const r of runners) {
                        const top = r.dest && r.dest !== "." ? r.dest.split("/")[0] : "";
                        const key = top || "\u0000root"; // sentinel sorts first
                        if (!groups.has(key)) groups.set(key, []);
                        groups.get(key)!.push(r);
                      }
                      const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
                      return keys.map((key) => {
                        const list = groups.get(key)!;
                        const label = key === "\u0000root" ? "/ (root)" : key;
                        const collapsed = collapsedRunnerGroups.has(key);
                        const building = list.some((r) => r.status === "building");
                        return (
                          <div className="grgroup" key={key}>
                            <button
                              className="grgroup-hd"
                              onClick={() => setCollapsedRunnerGroups((s) => {
                                const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n;
                              })}
                            >
                              <span className={`grgroup-caret${collapsed ? " is-collapsed" : ""}`}>{Chevron}</span>
                              <span className="grgroup-folder" aria-hidden>{Folder}</span>
                              <span className="grgroup-name">{label}</span>
                              {building && <span className="gear-spin grgroup-gear" aria-hidden>{Gear}</span>}
                              <span className="grgroup-count">{list.length}</span>
                            </button>
                            {!collapsed && list.map((r) => (
                              <button
                                key={r.id}
                                className={`gmrow gmrow--nested${r.id === selectedRunnerId ? " is-active" : ""}`}
                                onClick={() => setSelectedRunnerId(r.id)}
                              >
                                <span className={`rstatus rstatus--${r.status}`} title={r.status}>
                                  {r.status === "building" ? <span className="recalc-spin" /> : <span className="rdot" />}
                                </span>
                                <span className="gmrow-repo">{shortRepo(r.repo)}</span>
                              </button>
                            ))}
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>

                {/* detail: the selected runner, or an empty hint */}
                <div className="gdetail">
                  {!selected && (
                    <div className="gdetail-empty">
                      <p className="gdetail-hint">Select a runner on the left to view and manage it.</p>
                    </div>
                  )}
                  {selected && (
                    <div className="gdtl">
                      <div className="gdtl-top">
                        <a className="gdtl-repo" href={repoWebUrl(selected.repo)} target="_blank" rel="noopener noreferrer">{shortRepo(selected.repo)}</a>
                        <span className={`rbadge rbadge--${selected.status}`}>{selected.status}</span>
                      </div>
                      <div className="gdtl-fields">
                        <div className="gdtl-field"><span className="rk">repository</span><code className="gdtl-v">{selected.repo}</code></div>
                        <div className="gdtl-field"><span className="rk">branch</span><span className="gdtl-v">{selected.branch || "default"}</span></div>
                        <div className="gdtl-field"><span className="rk">destination</span><span className="gdtl-v">{selected.dest === "" || selected.dest === "." ? "/ (root)" : "/" + selected.dest}</span></div>
                        <div className="gdtl-field"><span className="rk">last build</span><span className="gdtl-v">
                          {selected.lastSha ? <>{selected.lastSha.slice(0, 7)} · {relTime(selected.lastBuilt)}</> : "not built yet"}
                        </span></div>
                        <div className="gdtl-field"><span className="rk">last checked</span><span className="gdtl-v">
                          {selected.lastChecked ? relTime(selected.lastChecked) : "—"}
                        </span></div>
                      </div>
                      {selected.written && selected.written.length > 0 && (
                        <div className="gdtl-artifacts">
                          <span className="rk">artifacts ({selected.written.length})</span>
                          <div className="gdtl-art-list">
                            {selected.written.map((w) => (
                              <a key={w} className="rart" href={viewUrl(w)} target="_blank" rel="noopener noreferrer">/{w}</a>
                            ))}
                          </div>
                        </div>
                      )}
                      {selected.status === "error" && selected.error && <div className="rerr">✕ {selected.error}</div>}
                      <div className="gdtl-actions">
                        <button
                          className="mbtn mbtn--go"
                          disabled={selected.status === "building"}
                          onClick={() => rebuildRunner(selected.id)}
                        >
                          {selected.status === "building" ? "Building…" : "Rebuild now"}
                        </button>
                        <button className="mbtn mbtn--danger" onClick={() => { removeRunner(selected.id); setSelectedRunnerId(null); }}>
                          {Trash} Remove runner
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {gitJob && (
              <div className="gbuild">
                <div className="gphases">
                  {(["cloning", "building", "copying", "done"] as const).map((ph) => {
                    const order = ["cloning", "building", "copying", "done"];
                    const cur = gitJob.phase === "error" ? -1 : order.indexOf(gitJob.phase);
                    const idx = order.indexOf(ph);
                    const state = gitJob.phase === "error" ? "idle" : idx < cur ? "done" : idx === cur ? "active" : "idle";
                    return <span key={ph} className={`gphase is-${state}`}>{ph}</span>;
                  })}
                  <button className="glog-close" onClick={() => setGitJob(null)} aria-label="Dismiss log">{Cross}</button>
                </div>
                <pre className="glog" ref={gitLogRef}>{gitJob.logs.join("") || "starting…\n"}</pre>
                {gitJob.phase === "error" && <p className="gerror">✕ {gitJob.error}</p>}
                {gitJob.phase === "done" && <p className="gdone">✓ Artifacts added to <code>{gitJob.dest}</code></p>}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {tokenModal && (() => {
        const signin = denied === "token"; // auth actually required — must sign in
        const close = () => { if (!signin) setTokenModal(false); };
        return (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <span className="modal-title"><span className="modal-title-ic">{KeyIcon}</span> {signin ? "Sign in" : "Auth token"}</span>
              {!signin && <button className="modal-close" onClick={() => setTokenModal(false)} aria-label="Close">{Cross}</button>}
            </div>
            <p className="modal-text">
              {signin
                ? "This server requires an access token to connect. Paste your token to sign in."
                : "Required for uploads, deletes, and runners. Stored locally in this browser and sent as a bearer token."}
            </p>
            <div className="gform">
              <label className="gfield">
                <span className="glabel">Token</span>
                <input
                  className="ginput mono" type="password" placeholder="paste your token" autoFocus
                  value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && tokenDraft.trim()) { saveToken(tokenDraft.trim()); setTokenModal(false); } }}
                />
              </label>
            </div>
            <div className="modal-actions">
              {token && !signin && <button className="mbtn mbtn--ghost" onClick={() => { saveToken(""); setTokenDraft(""); setTokenModal(false); }}>Clear</button>}
              {!signin && <button className="mbtn mbtn--ghost" onClick={() => setTokenModal(false)}>Cancel</button>}
              <button className="mbtn mbtn--go" disabled={!tokenDraft.trim()} onClick={() => { saveToken(tokenDraft.trim()); setTokenModal(false); }}>
                {signin ? "Sign in" : "Save"}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ── Merkle graph viewer ──────────────────────────────────────────────────────
// A self-contained animated SVG of the tree: directories/files as nodes, hashes
// shown, parent→child links drawing in. No external deps. Layered left→right.
type GNode = {
  key: string; name: string; type: "file" | "directory"; sha: string;
  depth: number; x: number; y: number; parent?: string;
};
function MerkleGraph({ tree, version, removing, onCopy, onCopyLink, onDownload, onDelete, onCopyRoot, onClose }: {
  tree: TreeNode; version: number;
  removing: Set<string>;
  onCopy: (h: string) => void;
  onCopyLink: (path: string) => void;
  onDownload: (node: { path: string; name: string; type: "file" | "directory" }) => void;
  onDelete: (node: { path: string; name: string; type: "file" | "directory" }) => void;
  onCopyRoot: () => void;
  onClose: () => void;
}) {
  const ROW = 34, COL = 200, R = 7, MAX_NODES = 240;
  const DUP_COLORS = ["#FF6B6B", "#FFA94D", "#FFD43B", "#A88BFA", "#4DABF7", "#38D9A9", "#F783AC", "#9CC2FF", "#E599F7", "#63E6BE"];
  const prevShas = useRef<Map<string, string>>(new Map());

  const { nodes, edges, width, height, changed, dupColor, dupGroups } = useMemo(() => {
    const nodes: GNode[] = [];
    const edges: { from: GNode; to: GNode }[] = [];
    let leaf = 0, count = 0, truncated = false;

    // ── duplicate detection over the WHOLE tree (files only) ─────────────────
    // identical sha256 = identical content. Group files by hash; any hash with
    // 2+ files is a duplicate set wasting (n-1)×size bytes.
    type DupAcc = { hash: string; paths: string[]; size: number };
    const byHash = new Map<string, DupAcc>();
    const collect = (node: TreeNode) => {
      if (node.type === "file" && node.sha256) {
        const acc = byHash.get(node.sha256) || { hash: node.sha256, paths: [], size: node.size || 0 };
        acc.paths.push(node.path);
        if (node.size) acc.size = node.size;
        byHash.set(node.sha256, acc);
      }
      for (const c of node.children || []) collect(c);
    };
    collect(tree);
    const dupGroups = [...byHash.values()]
      .filter((g) => g.paths.length > 1)
      .map((g) => ({ ...g, copies: g.paths.length, wasted: (g.paths.length - 1) * g.size }))
      .sort((a, b) => b.wasted - a.wasted || b.copies - a.copies);
    const dupColor = new Map<string, string>();
    dupGroups.forEach((g, i) => dupColor.set(g.hash, DUP_COLORS[i % DUP_COLORS.length]));

    // recursive layout: y from leaf order, internal nodes centered on children
    const walk = (node: TreeNode, depth: number, parentKey?: string): GNode | null => {
      if (count >= MAX_NODES) { truncated = true; return null; }
      count++;
      const key = node.path || ".";
      const g: GNode = { key, name: node.name || "root", type: node.type, sha: node.sha256 || "", depth, x: depth * COL + 40, y: 0, parent: parentKey };
      nodes.push(g);
      const kids = node.children && node.children.length ? [...node.children].sort(
        (a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name))
      ) : [];
      if (!kids.length) { g.y = leaf++ * ROW + 28; }
      else {
        const childGs: GNode[] = [];
        for (const k of kids) { const cg = walk(k, depth + 1, key); if (cg) { childGs.push(cg); edges.push({ from: g, to: cg }); } }
        g.y = childGs.length ? (childGs[0].y + childGs[childGs.length - 1].y) / 2 : leaf++ * ROW + 28;
      }
      return g;
    };
    walk(tree, 0);

    // which nodes changed hash since last render → pulse them
    const changed = new Set<string>();
    for (const n of nodes) { const p = prevShas.current.get(n.key); if (p !== undefined && p !== n.sha) changed.add(n.key); }
    const next = new Map<string, string>(); for (const n of nodes) next.set(n.key, n.sha);
    prevShas.current = next;

    const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    const width = (maxDepth + 1) * COL + 80;
    const height = Math.max(leaf, 1) * ROW + 40;
    if (truncated) nodes.push({ key: "__more__", name: `… ${MAX_NODES}+ nodes (truncated)`, type: "file", sha: "", depth: 0, x: 40, y: height - 6, parent: undefined });
    return { nodes, edges, width, height, changed, dupColor, dupGroups };
  }, [tree, version]);

  // transform-based pan/zoom: a <g> carries translate + scale over a fill-the-box SVG
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 });
  const [selectedDup, setSelectedDup] = useState<string | null>(null);
  const [hoveredDup, setHoveredDup] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ node: GNode; sx: number; sy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const q = query.trim().toLowerCase();
  const matchSet = useMemo(() => {
    if (!q) return null;
    const s = new Set<string>();
    for (const n of nodes) {
      if (n.key === "__more__") continue;
      if (n.name.toLowerCase().includes(q) || n.sha.toLowerCase().includes(q)) s.add(n.key);
    }
    return s;
  }, [q, nodes]);
  const matchCount = matchSet ? matchSet.size : 0;

  const clampZoom = (z: number) => Math.min(4, Math.max(0.1, z));

  const fitView = () => {
    const el = boxRef.current;
    if (!el) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    const z = clampZoom(Math.min((cw - 32) / width, (ch - 32) / height));
    setView({ z, tx: (cw - width * z) / 2, ty: (ch - height * z) / 2 });
  };
  // fit when the graph opens or its content size changes
  useEffect(() => { fitView(); /* eslint-disable-next-line */ }, [width, height]);
  // close the node popover whenever the view moves (so it can't float out of place)
  useEffect(() => { setPicked(null); }, [view.tx, view.ty, view.z]);

  // zoom around a container-relative point (keeps that point fixed under the cursor)
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const { z, tx, ty } = viewRef.current;
    const nz = clampZoom(z * factor);
    const k = nz / z;
    setView({ z: nz, tx: cx - (cx - tx) * k, ty: cy - (cy - ty) * k });
  };
  const zoomCenter = (factor: number) => {
    const el = boxRef.current;
    if (!el) return;
    zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
  };

  // wheel zoom (no modifier) toward cursor + drag to pan
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    let down = false, dragging = false, sx = 0, sy = 0, btx = 0, bty = 0;
    const onDown = (e: PointerEvent) => {
      down = true; dragging = false; sx = e.clientX; sy = e.clientY;
      btx = viewRef.current.tx; bty = viewRef.current.ty;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) {
        dragging = true; el.classList.add("is-panning");
        el.setPointerCapture?.(e.pointerId); // capture only once a real drag starts
      }
      if (dragging) setView((v) => ({ ...v, tx: btx + dx, ty: bty + dy }));
    };
    const onUp = () => { down = false; dragging = false; el.classList.remove("is-panning"); };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <>
      <div className="graph-zoom">
        <button
          className="graph-roothash"
          title={`root ${tree.sha256} — click to copy`}
          onClick={onCopyRoot}
        >
          <span className="graph-roothash-k">root</span>
          <span className="graph-roothash-v">{shortHash(tree.sha256)}</span>
          <span className="graph-roothash-ic" aria-hidden>{CopyIcon}</span>
        </button>
        <span className="graph-zspacer" />
        <button className="graph-zbtn" onClick={() => zoomCenter(1 / 1.25)} aria-label="Zoom out" title="Zoom out">−</button>
        <span className="graph-zlvl" onClick={fitView} title="Fit to view">{Math.round(view.z * 100)}%</span>
        <button className="graph-zbtn" onClick={() => zoomCenter(1.25)} aria-label="Zoom in" title="Zoom in">+</button>
        <button className="graph-zfit" onClick={fitView} title="Fit to view">Fit</button>
        <div className="graph-search">
          <input
            className="graph-search-in"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search name or hash…"
            spellCheck={false}
          />
          {query && <button className="graph-search-x" onClick={() => setQuery("")} aria-label="Clear search">{Cross}</button>}
          {q && <span className="graph-search-n">{matchCount} match{matchCount === 1 ? "" : "es"}</span>}
        </div>
        <button className="modal-close graph-close" aria-label="Close" onClick={onClose}>{Cross}</button>
      </div>
      <div className="graph-scroll" ref={boxRef}>
        <svg className="graph-svg" width="100%" height="100%">
          <defs>
            <linearGradient id="edgeg" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.15" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.6" />
            </linearGradient>
          </defs>
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.z})`} className={(matchSet || hoveredDup || selectedDup) ? "is-spotlight" : ""}>
            {edges.map((e, i) => {
              const x1 = e.from.x + R, y1 = e.from.y, x2 = e.to.x - R, y2 = e.to.y, mx = (x1 + x2) / 2;
              const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
              return <path key={i} className="graph-edge" d={d} pathLength={1} style={{ animationDelay: `${e.to.depth * 80}ms` }} />;
            })}
            {nodes.map((n) => {
              if (n.key === "__more__") return <text key={n.key} className="graph-more" x={n.x} y={n.y}>{n.name}</text>;
              const isRoot = n.key === ".";
              const dc = n.sha ? dupColor.get(n.sha) : undefined;
              const isRemoving = removing.has(n.key) || [...removing].some((p) => n.key === p || n.key.startsWith(p + "/"));
              // search takes precedence; otherwise fall back to duplicate hover/selection
              let isFocus: boolean, dimmed: boolean;
              if (matchSet) { isFocus = matchSet.has(n.key); dimmed = !isFocus; }
              else { const f = hoveredDup ?? selectedDup; isFocus = f !== null && n.sha === f; dimmed = f !== null && !isFocus; }
              const cls = `graph-node ${n.type === "directory" ? "is-dir" : "is-file"}${isRoot ? " is-root" : ""}${changed.has(n.key) ? " is-changed" : ""}${dc ? " is-dup" : ""}${dimmed ? " is-dim" : ""}${isFocus ? " is-focus" : ""}${matchSet && isFocus ? " is-match" : ""}${isRemoving ? " is-removing" : ""}`;
              return (
                <g key={n.key} className={cls} style={{ animationDelay: `${n.depth * 80 + 40}ms` }}
                   onClick={(ev) => {
                     ev.stopPropagation();
                     const el = boxRef.current; if (!el) return;
                     // node content coords → container-relative pixels (popover lives inside the box)
                     const px = view.tx + n.x * view.z;
                     const py = view.ty + n.y * view.z;
                     setPicked({ node: n, sx: px, sy: py });
                   }} role="button">
                  {dc && <circle className="dup-ring" cx={n.x} cy={n.y} r={R + 4} fill="none" stroke={dc} strokeWidth={2.5} />}
                  {n.type === "directory"
                    ? <rect x={n.x - R} y={n.y - R} width={R * 2} height={R * 2} rx="3" transform={`rotate(45 ${n.x} ${n.y})`}
                            style={dc ? { stroke: dc } : undefined} />
                    : <circle cx={n.x} cy={n.y} r={R} style={dc ? { stroke: dc } : undefined} />}
                  <text className={`graph-name${isRemoving ? " is-strike" : ""}`} x={n.x + R + 7} y={n.y - 2}>{n.name}</text>
                  <text className="graph-hash" x={n.x + R + 7} y={n.y + 9}>{isRemoving ? "deleting…" : (n.sha ? n.sha.slice(0, 10) : "—")}</text>
                </g>
              );
            })}
          </g>
        </svg>

        {dupGroups.length > 0 && (
          <div className="dup-legend">
            <div className="dup-legend-hd">
              <span>Duplicate data</span>
              <span className="dup-legend-waste" title="Total space wasted by duplicate copies">
                {formatBytes(dupGroups.reduce((s, g) => s + g.wasted, 0))} wasted
              </span>
            </div>
            <div className="dup-legend-list">
              {dupGroups.map((g, i) => {
                const color = dupColor.get(g.hash)!;
                const active = selectedDup === g.hash;
                return (
                  <button
                    key={g.hash}
                    className={`dup-item${active ? " is-active" : ""}`}
                    onClick={() => setSelectedDup(active ? null : g.hash)}
                    onMouseEnter={() => setHoveredDup(g.hash)}
                    onMouseLeave={() => setHoveredDup(null)}
                    title={g.paths.join("\n")}
                  >
                    <span className="dup-swatch" style={{ background: color }}>{i + 1}</span>
                    <span className="dup-info">
                      <span className="dup-line1">{g.copies}× copies · {formatBytes(g.size)} each</span>
                      <span className="dup-line2">{g.hash.slice(0, 12)} · {formatBytes(g.wasted)} wasted</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedDup && <div className="dup-legend-clear" onClick={() => setSelectedDup(null)}>clear highlight</div>}
          </div>
        )}

        {picked && picked.node.key !== "__more__" && (() => {
          const el = boxRef.current;
          const cw = el?.clientWidth ?? 0, ch = el?.clientHeight ?? 0;
          const PW = 170, PH = 80; // approx popover footprint for clamping
          const left = Math.max(8, Math.min(picked.sx, cw - PW - 8));
          const above = picked.sy > PH + 16;
          const top = above ? Math.max(8, picked.sy - PH - 12) : Math.min(ch - PH - 8, picked.sy + 16);
          return (
            <>
              <div className="node-pop-scrim" onClick={() => setPicked(null)} />
              <div className="node-pop" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
                <div className="node-pop-name" title={picked.node.key === "." ? "root" : picked.node.key}>
                  {picked.node.key === "." ? "root" : picked.node.name}
                </div>
                <div className="node-pop-acts">
                  {picked.node.key !== "." && (
                    <button className="node-pop-btn node-pop-danger" title="Delete"
                            onClick={() => { onDelete({ path: picked.node.key, name: picked.node.name, type: picked.node.type }); setPicked(null); }}>
                      {Trash}
                    </button>
                  )}
                  <button className="node-pop-btn" title="Copy link"
                          onClick={() => { onCopyLink(picked.node.key); setPicked(null); }}>
                    {LinkIcon}
                  </button>
                  <button className="node-pop-btn" title={picked.node.type === "file" ? "Download" : "Download as zip"}
                          onClick={() => { onDownload({ path: picked.node.key, name: picked.node.name, type: picked.node.type }); setPicked(null); }}>
                    {Download}
                  </button>
                  <button className="node-pop-btn" title="Copy hash"
                          onClick={() => { picked.node.sha && onCopy(picked.node.sha); setPicked(null); }}>
                    <svg viewBox="0 0 16 16" width="14" height="14"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5"
                      transform="rotate(45 8 8)" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
                  </button>
                </div>
              </div>
            </>
          );
        })()}
      </div>
    </>
  );
}


const DiamondLg = (
  <svg viewBox="0 0 32 32" width="34" height="34"><rect x="8" y="8" width="16" height="16" rx="4"
    transform="rotate(45 16 16)" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
);
const Folder = (
  <svg viewBox="0 0 18 18" width="17" height="17"><path
    d="M1.5 4.5a1 1 0 011-1h3.6a1 1 0 01.7.3l1 1a1 1 0 00.7.3h6.3a1 1 0 011 1v6.6a1 1 0 01-1 1H2.5a1 1 0 01-1-1z"
    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
);
// small robot glyph for the "runners inside this folder" badge
const RobotIcon = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
    <rect x="3" y="6" width="10" height="7" rx="1.6" />
    <path d="M8 6V3.5M8 3.5a1 1 0 100-2 1 1 0 000 2z" />
    <circle cx="6" cy="9.3" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="10" cy="9.3" r="0.7" fill="currentColor" stroke="none" />
    <path d="M1.8 8.5v2M14.2 8.5v2" />
  </svg>
);
// gear for the "a runner is building here" spinner
const Gear = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" strokeLinecap="round" />
  </svg>
);
// compact disk/storage glyph for the status-bar chip
const Disk = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2">
    <ellipse cx="8" cy="4" rx="5.2" ry="2.1" />
    <path d="M2.8 4v8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V4" strokeLinejoin="round" />
    <path d="M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1" />
  </svg>
);
const File = (
  <svg viewBox="0 0 18 18" width="16" height="16"><path
    d="M4 2.5h6l4 4v9a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5z M10 2.5v4h4"
    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
);
const Download = (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 1.5v8m0 0L5 6.5m3 3l3-3M2.5 12.5h11"
    fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Upload = (
  <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 14.5v-8m0 0L5 9.5m3-3l3 3M2.5 3.5h11"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Plus = (
  <svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 5v14M5 12h14"
    fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
);
const Check = (
  <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5l3.5 3.5L13 5"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Cross = (
  <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
);
const Trash = (
  <svg viewBox="0 0 16 16" width="15" height="15"><path
    d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8a1 1 0 001 1h3a1 1 0 001-1l.5-8M6.8 7v4M9.2 7v4"
    fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const LinkIcon = (
  <svg viewBox="0 0 16 16" width="15" height="15"><path
    d="M6.5 9.5l3-3M6 5.5l.8-.8a2.4 2.4 0 013.5 3.5l-.8.8M10 10.5l-.8.8a2.4 2.4 0 01-3.5-3.5l.8-.8"
    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const CopyIcon = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
    <path d="M10.5 5.5V3.9a1.4 1.4 0 00-1.4-1.4H3.9A1.4 1.4 0 002.5 3.9v5.2a1.4 1.4 0 001.4 1.4h1.6" />
  </svg>
);
const CsvIcon = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 2.5h6l3 3v8a0 0 0 010 0H3.5a0 0 0 010 0z" />
    <path d="M9.5 2.5v3h3" />
    <path d="M5.3 8.3h5.4M5.3 10.6h5.4" />
  </svg>
);
const GitIcon = (
  <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="5" cy="4" r="2" /><circle cx="5" cy="14" r="2" /><circle cx="13" cy="9" r="2" />
    <path d="M5 6v6M5 12c0-3 3-3 6-3" strokeLinecap="round" />
  </svg>
);
const Chevron = (
  <svg viewBox="0 0 16 16" width="13" height="13"><path d="M6 4l4 4-4 4" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const KeyIcon = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="3.2" y="7" width="9.6" height="6.6" rx="1.8" />
    <path d="M5.4 7V5.1a2.6 2.6 0 015.2 0V7" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="8" cy="10.3" r="0.85" fill="currentColor" stroke="none" />
  </svg>
);
// ── helpers ─────────────────────────────────────────────────────────────────
// POST a FormData with upload progress (fetch can't report upload progress).
function xhrUpload(url: string, fd: FormData, onProgress: (loaded: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (authToken) xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
      } else if (xhr.status === 401) {
        reject(new Error("AUTH"));
      } else reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(fd);
  });
}

// ── resumable chunked upload (large files) ───────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  // crypto.subtle only exists in a secure context (https / localhost). On a
  // plain-http dev origin it's undefined — skip the hash so uploads still work;
  // the server verifies only when the header is present.
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
type PersistedUpload = { id: string; name: string; size: number; dir: string; lastModified: number; received: number };

function loadPersistedUploads(): PersistedUpload[] {
  try { return JSON.parse(localStorage.getItem("onesvd_uploads") || "[]"); } catch { return []; }
}
function persistUpload(u: PersistedUpload) {
  try {
    const all = loadPersistedUploads().filter((x) => x.id !== u.id);
    all.push(u);
    localStorage.setItem("onesvd_uploads", JSON.stringify(all));
  } catch {}
}
function clearPersistedUpload(id: string) {
  try {
    localStorage.setItem("onesvd_uploads", JSON.stringify(loadPersistedUploads().filter((x) => x.id !== id)));
  } catch {}
}

// upload one chunk with retry+backoff; returns the server's new received count.
// onState reports "retrying" so the UI can show a reconnecting state.
async function postChunk(
  id: string, offset: number, buf: ArrayBuffer, sha: string, onState: (s: "ok" | "retry") => void
): Promise<number> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${UPLOAD_URL}/chunk?id=${encodeURIComponent(id)}&offset=${offset}`, {
        method: "POST",
        headers: authHeaders(sha ? { "Content-Type": "application/octet-stream", "X-Chunk-Sha256": sha } : { "Content-Type": "application/octet-stream" }),
        body: buf,
      });
      if (res.status === 401) throw Object.assign(new Error("AUTH"), { auth: true });
      if (res.status === 409) { const j = await res.json(); onState("ok"); return j.received; } // resync
      if (res.status === 422) { onState("retry"); throw new Error("chunk rejected"); }            // hash mismatch → retry
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      onState("ok");
      return j.received;
    } catch (e: any) {
      if (e && e.auth) throw e;
      attempt++;
      if (attempt > 100) throw new Error("upload failed after many retries");
      onState("retry");
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))); // backoff to 30s, retry indefinitely
    }
  }
}

// returns {sha256} on success; throws on auth/fatal error
async function chunkedUpload(
  file: File, dir: string, onProgress: (sent: number, retrying: boolean) => void
): Promise<{ sha256: string }> {
  const key = `${file.name}|${file.size}|${file.lastModified}|${dir}`;
  const initRes = await fetch(`${UPLOAD_URL}/init`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ key, name: file.name, size: file.size, dir }),
  });
  if (initRes.status === 401) throw Object.assign(new Error("AUTH"), { auth: true });
  if (!initRes.ok) throw new Error((await initRes.text()) || `HTTP ${initRes.status}`);
  const { id, received } = await initRes.json();

  let offset: number = received || 0;
  const persist = () => persistUpload({ id, name: file.name, size: file.size, dir, lastModified: file.lastModified, received: offset });
  persist();
  onProgress(offset, false);

  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const buf = await file.slice(offset, end).arrayBuffer();
    const sha = await sha256Hex(buf);
    offset = await postChunk(id, offset, buf, sha, (s) => onProgress(offset, s === "retry"));
    persist();
    onProgress(offset, false);
  }

  const finRes = await fetch(`${UPLOAD_URL}/finish?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({}),
  });
  if (finRes.status === 401) throw Object.assign(new Error("AUTH"), { auth: true });
  if (!finRes.ok) throw new Error((await finRes.text()) || `HTTP ${finRes.status}`);
  const out = await finRes.json();
  clearPersistedUpload(id);
  return { sha256: out.sha256 };
}

function pct(sent: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((sent / total) * 100));
}
function relTime(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function shortRepo(url: string): string {
  return url
    .replace(/^git@(github|gitlab)\.com:/, "")
    .replace(/^ssh:\/\/git@(github|gitlab)\.com\//, "")
    .replace(/^https:\/\/(www\.)?(github|gitlab)\.com\//, "")
    .replace(/\.git$/, "");
}
// turn an SSH clone URL into a browsable https URL for the repo host
function repoWebUrl(url: string): string {
  const m =
    /^git@(github|gitlab)\.com:(.+?)(\.git)?$/.exec(url) ||
    /^ssh:\/\/git@(github|gitlab)\.com\/(.+?)(\.git)?$/.exec(url);
  if (m) return `https://${m[1]}.com/${m[2]}`;
  if (/^https?:\/\//.test(url)) return url.replace(/\.git$/, "");
  return url;
}
function joinDir(cwd: string, relPath: string): string {
  if (cwd === "." || cwd === "") return relPath || ".";
  return relPath ? `${cwd}/${relPath}` : cwd;
}
// join a dir path and a child name into a tree path (root "." has no prefix)
function treeJoin(dir: string, name: string): string {
  return dir === "." || dir === "" ? name : `${dir}/${name}`;
}
// recursively read a dropped DataTransfer entry into {file, relPath} list,
// where relPath is the directory path (relative to the drop), preserving structure.
async function walkEntry(entry: any, dirPrefix: string): Promise<{ file: File; relPath: string }[]> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    return [{ file, relPath: dirPrefix }];
  }
  const here = dirPrefix ? `${dirPrefix}/${entry.name}` : entry.name;
  const children = await readAllEntries(entry.createReader());
  const out: { file: File; relPath: string }[] = [];
  for (const c of children) out.push(...(await walkEntry(c, here)));
  return out;
}
function readAllEntries(reader: any): Promise<any[]> {
  return new Promise((resolve) => {
    const all: any[] = [];
    const next = () =>
      reader.readEntries((batch: any[]) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, () => resolve(all));
    next();
  });
}
function nodeAt(root: TreeNode, path: string): TreeNode | null {
  if (path === ".") return root;
  let node: TreeNode | undefined = root;
  for (const seg of path.split("/")) {
    node = node?.children?.find((c) => c.name === seg && c.type === "directory");
    if (!node) return null;
  }
  return node ?? null;
}
// does a path exist in the tree, file OR directory?
function pathExists(root: TreeNode, path: string): boolean {
  if (path === ".") return true;
  const segs = path.split("/");
  let node: TreeNode | undefined = root;
  for (let i = 0; i < segs.length; i++) {
    const child: TreeNode | undefined = node?.children?.find((c) => c.name === segs[i]);
    if (!child) return false;
    node = child;
  }
  return !!node;
}
function shortHash(h: string) {
  return h ? h.slice(0, 7) : "·······";
}
function viewUrl(relPath: string) {
  return `${VIEW_BASE}?path=${encodeURIComponent(relPath)}`;
}
function downloadUrl(relPath: string) {
  return `${DOWNLOAD_BASE}?path=${encodeURIComponent(relPath)}`;
}
function zipUrl(relPath: string) {
  return `${ZIP_BASE}?path=${encodeURIComponent(relPath)}`;
}
function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function count(n: TreeNode): { files: number; dirs: number; bytes: number } {
  if (n.type === "file") return { files: 1, dirs: 0, bytes: n.size ?? 0 };
  let files = 0, dirs = 0, bytes = 0;
  for (const c of n.children ?? []) {
    if (c.type === "directory") dirs++;
    const r = count(c);
    files += r.files; dirs += r.dirs; bytes += r.bytes;
  }
  return { files, dirs, bytes };
}
function applyPatch(root: TreeNode, changes: Change[]): TreeNode {
  let next = root;
  for (const c of changes) {
    if (c.path === ".") {
      // the root recompute — update the root node's hash instead of dropping it
      if (c.sha256) next = { ...next, sha256: c.sha256 };
      continue;
    }
    next = edit(next, c.path.split("/"), c, 0);
  }
  return next;
}
function edit(node: TreeNode, parts: string[], c: Change, consumed: number): TreeNode {
  const [head, ...rest] = parts;
  const children = node.children ? [...node.children] : [];
  const i = children.findIndex((ch) => ch.name === head);
  if (rest.length === 0) {
    if (c.op === "delete") {
      if (i !== -1) children.splice(i, 1);
    } else {
      const updated: TreeNode = {
        name: head, path: c.path, type: c.type ?? "file", sha256: c.sha256 ?? "",
        size: c.size, children: i !== -1 ? children[i].children : c.type === "directory" ? [] : undefined,
      };
      if (i !== -1) children[i] = updated; else children.push(updated);
      children.sort((a, b) => a.name.localeCompare(b.name));
    }
  } else {
    // descend; if an intermediate folder doesn't exist yet, create it so a
    // deeply-nested upsert (e.g. a/b/c/file) is never dropped for a missing parent
    let child: TreeNode;
    if (i !== -1) {
      child = children[i];
    } else {
      if (c.op === "delete") return { ...node, children }; // nothing to descend into
      // synthesize the missing parent dir; its real hash arrives in its own change
      const parentPath = c.path.split("/").slice(0, consumed + 1).join("/");
      child = { name: head, path: parentPath, type: "directory", sha256: "", children: [] };
      children.push(child);
      children.sort((a, b) => a.name.localeCompare(b.name));
    }
    const idx = children.findIndex((ch) => ch.name === head);
    children[idx] = edit(child, rest, c, consumed + 1);
  }
  return { ...node, children };
}

// ── styles ──────────────────────────────────────────────────────────────────
const CSS = `
.svd {
  --bg: #000000;
  --panel: rgba(255,255,255,0.025);
  --panel-hover: rgba(255,255,255,0.05);
  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.16);
  --text: #F4F6F5;
  --muted: #6E7E7A;
  --faint: #424E4B;
  --accent: #16E1A0;
  --accent-bright: #5BF4C6;
  --accent-dim: rgba(22,225,160,0.12);
  --accent-glow: rgba(22,225,160,0.45);
  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  --gridcols: minmax(0,1fr) 110px 120px 118px;

  min-height: 100vh; display: flex; flex-direction: column;
  background: radial-gradient(1100px 520px at 50% -140px, rgba(22,225,160,0.09), transparent 60%), var(--bg);
  color: var(--text); font-family: var(--font-sans); -webkit-font-smoothing: antialiased;
}
.svd *, .svd *::before, .svd *::after { box-sizing: border-box; }

/* navbar */
.nav {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 16px;
  height: 60px; padding: 0 22px;
  border-bottom: 1px solid var(--border);
  background: rgba(0,0,0,0.72); backdrop-filter: blur(14px);
}
.brand {
  display: flex; align-items: center; gap: 11px; flex: 0 0 auto;
  background: none; border: none; padding: 0; cursor: pointer; text-decoration: none;
}
.word { font-size: 19px; font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
.word-accent { color: var(--accent); text-shadow: 0 0 16px var(--accent-glow); }
.nav-right { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; margin-left: auto; }
.authbtn {
  display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px;
  background: transparent; border: 1px solid var(--border); color: var(--muted); cursor: pointer;
  transition: color .12s, border-color .12s, background .12s;
}
.authbtn:hover { color: var(--text); border-color: var(--border-strong); }
.authbtn.is-set { color: var(--accent); border-color: rgba(22,225,160,0.4); background: var(--accent-dim); }

.authbanner {
  display: flex; align-items: center; gap: 14px;
  padding: 11px 22px; font-size: 13px; font-weight: 500;
  border-bottom: 1px solid;
}
.authbanner--ip { color: #E0584F; background: rgba(224,88,79,0.1); border-color: rgba(224,88,79,0.3); }
.authbanner--token { color: #E8B84B; background: rgba(232,184,75,0.1); border-color: rgba(232,184,75,0.3); }
.authbanner-btn {
  display: inline-flex; align-items: center; gap: 6px; margin-left: auto;
  padding: 5px 11px; font-size: 12px; font-weight: 600; cursor: pointer;
  color: var(--text); background: rgba(0,0,0,0.25); border: 1px solid var(--border-strong); border-radius: 7px;
}
.authbanner-btn:hover { border-color: var(--accent); color: var(--accent); }
.authbanner-btn svg { width: 13px; height: 13px; }

.resumebar {
  width: 100%;
  display: flex; flex-direction: column; gap: 10px;
  padding: 13px 15px; border-radius: 12px;
  background: rgba(10,13,12,0.97); border: 1px solid rgba(22,225,160,0.4);
  box-shadow: 0 16px 40px -16px rgba(0,0,0,0.7); backdrop-filter: blur(8px);
  font-size: 13px; color: var(--text);
}
.resumebar-hd { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text); }
.resumebar-ic { display: grid; place-items: center; color: var(--accent); flex: 0 0 auto; }
.resumebar-ic svg { width: 15px; height: 15px; }
.resumebar-cancelall {
  margin-left: auto; padding: 3px 9px; font-size: 11.5px; font-weight: 600; cursor: pointer;
  color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 6px;
}
.resumebar-cancelall:hover { color: #E0584F; border-color: rgba(224,88,79,0.4); }
.resumebar-list { display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow: auto; }
.resumebar-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 9px; background: rgba(255,255,255,0.03); border: 1px solid var(--border);
}
.resumebar-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.resumebar-name { font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resumebar-meta { font-family: var(--font-mono); font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resumebar-itemact { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.resumebar-btn {
  padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
  color: #04130D; background: var(--accent); border: none; border-radius: 7px;
}
.resumebar-btn:hover { background: var(--accent-bright); }
.resumebar-cancel {
  display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
  color: var(--muted); background: transparent; border: 1px solid var(--border);
}
.resumebar-cancel svg { width: 11px; height: 11px; }
.resumebar-cancel:hover { color: #E0584F; border-color: rgba(224,88,79,0.4); }

.fingerprint {
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px;
  font-family: var(--font-mono); font-size: 12.5px; color: var(--text);
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  transition: border-color .15s, background .15s;
}
.fingerprint:hover { border-color: var(--border-strong); background: var(--panel-hover); }
.fingerprint.is-copied { border-color: rgba(22,225,160,0.5); }
.fp-dot { width: 7px; height: 7px; border-radius: 2px; transform: rotate(45deg); background: var(--accent); box-shadow: 0 0 10px var(--accent-glow); }
.fp-label { color: var(--muted); }
.fp-hash { color: var(--accent-bright); letter-spacing: 0.02em; }
@media (prefers-reduced-motion: no-preference) {
  .fingerprint { animation: fp-pulse .9s ease-out; }
  @keyframes fp-pulse {
    0% { box-shadow: 0 0 0 0 var(--accent-glow); border-color: rgba(22,225,160,0.6); }
    100% { box-shadow: 0 0 0 8px rgba(22,225,160,0); border-color: var(--border); }
  }
}

/* explorer — full width */
.explorer { flex: 1; display: flex; flex-direction: column; width: 100%; position: relative; }

/* floating upload button (speed dial) */
.fab-wrap {
  position: fixed; right: 28px; bottom: 56px; z-index: 50;
  display: flex; flex-direction: column; align-items: flex-end; gap: 14px;
  pointer-events: none; /* wrap is transparent to clicks; children re-enable */
}
.fab-scrim { position: fixed; inset: 0; pointer-events: auto; }
.fab {
  width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--accent); color: #04130D; display: grid; place-items: center;
  box-shadow: 0 10px 34px -8px var(--accent-glow), 0 0 0 1px rgba(22,225,160,0.35);
  transition: background .15s, transform .15s;
  pointer-events: auto; /* the button itself stays clickable */
}
.fab:hover { background: var(--accent-bright); }
.fab:active { transform: scale(0.94); }
.fab-plus { display: grid; place-items: center; transition: transform .22s ease; }
.fab-wrap.is-open .fab-plus { transform: rotate(135deg); }

.fab-actions {
  display: flex; flex-direction: column; align-items: flex-end; gap: 12px;
  opacity: 0; transform: translateY(10px) scale(0.96); pointer-events: none;
  transition: opacity .15s ease, transform .15s ease;
}
.fab-wrap.is-open .fab-actions { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
.fab-action {
  display: flex; align-items: center; gap: 10px;
  background: none; border: none; padding: 0; cursor: pointer;
}
.fab-action-label {
  font-size: 12.5px; font-weight: 600; color: var(--text);
  background: rgba(0,0,0,0.82); border: 1px solid var(--border);
  padding: 6px 11px; border-radius: 7px; backdrop-filter: blur(8px); white-space: nowrap;
}
.fab-action-btn {
  width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(12,16,15,0.9); border: 1px solid var(--border-strong); color: var(--accent);
  backdrop-filter: blur(8px); transition: background .12s, border-color .12s;
}
.fab-action:hover .fab-action-btn { background: var(--accent-dim); border-color: rgba(22,225,160,0.5); }

/* upload folder modal */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; padding: 20px;
  background: rgba(0,0,0,0.62); backdrop-filter: blur(4px);
}
@media (prefers-reduced-motion: no-preference) {
  .modal-backdrop { animation: fade-in .14s ease-out; }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
}
.modal {
  width: 100%; max-width: 440px;
  background: rgba(10,13,12,0.97); border: 1px solid var(--border-strong);
  border-radius: 14px; padding: 18px; box-shadow: 0 24px 60px -20px rgba(0,0,0,0.85);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.modal-title { font-size: 14px; font-weight: 700; color: var(--text); }

/* Merkle graph viewer */
.modal-backdrop--graph { padding: 12px; }
.modal--graph {
  max-width: none; width: 100%; height: 100%; padding: 10px;
  display: flex; flex-direction: column;
}
.graph-bar {
  display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: nowrap; min-width: 0;
}
.graph-title { font-size: 13px; font-weight: 700; color: var(--text); flex: 0 0 auto; }
.graph-close { flex: 0 0 auto; width: 24px; height: 24px; }
.graph-sub { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.graph-roothash {
  display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto;
  padding: 5px 10px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--panel); cursor: pointer; transition: border-color .12s, background .12s;
}
.graph-roothash:hover { border-color: var(--border-strong); background: var(--panel-hover); }
.graph-roothash-k { font-size: 10px; letter-spacing: 0.4px; color: var(--faint); flex: 0 0 auto; }
.graph-roothash-v { font-family: var(--font-mono); font-size: 11.5px; color: var(--accent); flex: 0 0 auto; }
.graph-roothash-ic { display: grid; place-items: center; color: var(--muted); flex: 0 0 auto; }
.graph-roothash:hover .graph-roothash-ic { color: var(--text); }
.graph-copy {
  flex: 0 0 auto; padding: 3px 9px; font-size: 11px; font-weight: 600; cursor: pointer;
  color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
}
.graph-copy:hover { border-color: var(--accent); color: var(--accent); }
.graph-hint { font-size: 11px; color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-scroll {
  flex: 1; min-height: 0; position: relative; overflow: hidden;
  border: 1px solid var(--border); border-radius: 10px;
  background: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 0) 0 0 / 22px 22px,
              rgba(0,0,0,0.25);
  cursor: grab; touch-action: none;
}
.graph-scroll.is-panning { cursor: grabbing; }
.graph-svg { display: block; width: 100%; height: 100%; }
.graph-zoom { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; flex-wrap: nowrap; min-width: 0; }
.graph-zspacer { flex: 1 1 auto; }
.graph-zbtn {
  width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer;
  font-size: 15px; line-height: 1; color: var(--text);
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
}
.graph-zbtn:hover { border-color: var(--accent); color: var(--accent); }
.graph-zlvl {
  min-width: 42px; text-align: center; cursor: pointer;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--muted);
}
.graph-zlvl:hover { color: var(--text); }
.graph-zfit {
  padding: 4px 10px; cursor: pointer; font-size: 11.5px; font-weight: 600; color: var(--text);
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
}
.graph-zfit:hover { border-color: var(--accent); color: var(--accent); }
.graph-zhint { margin-left: auto; font-size: 11px; color: var(--muted); }
.graph-search { display: flex; align-items: center; gap: 7px; flex: 0 1 auto; min-width: 0; }
.graph-search-in {
  width: 200px; max-width: 40vw; min-width: 90px; flex: 0 1 auto; padding: 5px 10px; font-size: 12px;
  color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 7px;
  font-family: var(--font-sans); outline: none;
}
.graph-search-in::placeholder { color: var(--muted); }
.graph-search-in:focus { border-color: var(--accent); }
.graph-search-x {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
  color: var(--muted); background: transparent; border: 1px solid var(--border);
}
.graph-search-x svg { width: 10px; height: 10px; }
.graph-search-x:hover { color: var(--text); border-color: var(--border-strong); }
.graph-search-n { font-family: var(--font-mono); font-size: 11px; color: var(--accent); white-space: nowrap; }

.graph-edge {
  fill: none; stroke: url(#edgeg); stroke-width: 1.5;
  stroke-dasharray: 1; stroke-dashoffset: 1;
}
.graph-name { font-family: var(--font-sans); font-size: 11.5px; font-weight: 600; fill: var(--text); }
.graph-hash { font-family: var(--font-mono); font-size: 9.5px; fill: var(--muted); letter-spacing: 0.3px; }
.graph-more { font-family: var(--font-mono); font-size: 11px; fill: var(--muted); }
.graph-node { cursor: pointer; }
.graph-node circle, .graph-node rect { fill: var(--bg, #0a0d0c); stroke: var(--accent); stroke-width: 1.6; }
.graph-node.is-file circle { stroke: #8FB7AC; }
.graph-node.is-dir rect { fill: rgba(22,225,160,0.12); }
.graph-node.is-root circle, .graph-node.is-root rect { stroke-width: 2.4; filter: drop-shadow(0 0 6px var(--accent-glow)); }
.graph-node:hover circle, .graph-node:hover rect { fill: var(--accent-dim); }
.graph-node.is-dup circle, .graph-node.is-dup rect { stroke-width: 2.2; }
.dup-ring { opacity: 0.9; }
/* spotlight: when a duplicate set is focused, the rest of the tree goes near-black */
.is-spotlight .graph-edge { opacity: 0.06; transition: opacity .18s; }
.graph-node.is-dim { opacity: 0.07; transition: opacity .18s; }
.graph-node.is-focus { transition: opacity .18s; }
.graph-node.is-focus circle, .graph-node.is-focus rect {
  stroke-width: 3; filter: drop-shadow(0 0 9px currentColor) brightness(1.3);
}
.graph-node.is-focus .dup-ring { opacity: 1; stroke-width: 3.5; filter: drop-shadow(0 0 7px currentColor); }
.graph-node.is-focus .graph-name { fill: #fff; }
.graph-node.is-focus .graph-hash { fill: var(--text); }
/* search matches: distinct blue accent so they don't read as a duplicate group */
.graph-node.is-match circle, .graph-node.is-match rect {
  stroke: #4DABF7 !important; stroke-width: 3; fill: rgba(77,171,247,0.18);
  filter: drop-shadow(0 0 9px rgba(77,171,247,0.8));
}
.graph-node.is-match .graph-name { fill: #9CC2FF; }
/* optimistic delete: node fades + pulses red, name struck through, until the tree patch removes it */
.graph-node.is-removing circle, .graph-node.is-removing rect {
  stroke: #E0584F !important; fill: rgba(224,88,79,0.12) !important;
}
.graph-node.is-removing .graph-name { fill: #E0584F; }
.graph-name.is-strike { text-decoration: line-through; }
.graph-node.is-removing .graph-hash { fill: #E0584F; opacity: 0.8; }
@media (prefers-reduced-motion: no-preference) {
  .graph-node.is-removing { animation: node-removing 1s ease-in-out infinite; }
  @keyframes node-removing { 0%,100% { opacity: 0.85; } 50% { opacity: 0.4; } }
}
@media (prefers-reduced-motion: reduce) {
  .graph-node.is-removing { opacity: 0.6; }
}

/* duplicate legend */
.dup-legend {
  position: absolute; top: 12px; right: 12px; width: 270px; max-height: calc(100% - 24px);
  display: flex; flex-direction: column;
  background: rgba(10,13,12,0.96); border: 1px solid var(--border-strong); border-radius: 11px;
  box-shadow: 0 16px 40px -16px rgba(0,0,0,0.8); backdrop-filter: blur(10px); overflow: hidden;
}
.dup-legend-hd {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 11px 13px; border-bottom: 1px solid var(--border); font-weight: 700; font-size: 13px; color: var(--text);
}
.dup-legend-waste { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: #FFA94D; }
.dup-legend-list { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.dup-item {
  display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer;
  padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid transparent;
}
.dup-item:hover { background: rgba(255,255,255,0.06); }
.dup-item.is-active { border-color: var(--accent); background: var(--accent-dim); }
.dup-swatch {
  flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center;
  font-size: 11px; font-weight: 800; color: #04130D;
}
.dup-info { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dup-line1 { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dup-line2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dup-legend-clear {
  padding: 8px 13px; border-top: 1px solid var(--border); cursor: pointer;
  font-size: 11.5px; color: var(--muted); text-align: center;
}
.dup-legend-clear:hover { color: var(--accent); }

/* node action popover (lives inside the graph container) */
.node-pop-scrim { position: absolute; inset: 0; z-index: 80; }
.node-pop {
  position: absolute; z-index: 81;
  display: flex; flex-direction: column; gap: 7px; padding: 9px 10px;
  background: rgba(12,16,15,0.98); border: 1px solid var(--border-strong); border-radius: 10px;
  box-shadow: 0 14px 36px -12px rgba(0,0,0,0.85);
}
.node-pop-name {
  max-width: 220px; font-size: 12px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.node-pop-acts { display: flex; gap: 6px; }
.node-pop-btn {
  display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px; cursor: pointer;
  color: var(--muted); background: var(--panel); border: 1px solid var(--border);
  transition: color .12s, border-color .12s, background .12s;
}
.node-pop-btn:hover { color: var(--accent); border-color: var(--accent); }
.node-pop-btn svg { width: 14px; height: 14px; }
.node-pop-danger:hover { color: #E0584F; border-color: rgba(224,88,79,0.5); background: rgba(224,88,79,0.08); }
@media (prefers-reduced-motion: no-preference) {
  .graph-edge { animation: edge-draw .5s ease-out forwards; }
  @keyframes edge-draw { to { stroke-dashoffset: 0; } }
  .graph-node { animation: node-pop .32s ease-out both; transform-box: fill-box; transform-origin: center; }
  @keyframes node-pop { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: scale(1); } }
  .graph-node.is-changed circle, .graph-node.is-changed rect { animation: node-pulse 1.1s ease-out 2; }
  @keyframes node-pulse {
    0% { stroke: var(--accent); filter: drop-shadow(0 0 0 var(--accent-glow)); }
    40% { stroke: var(--accent-bright); filter: drop-shadow(0 0 9px var(--accent-glow)); }
    100% { filter: drop-shadow(0 0 0 transparent); }
  }
}
.modal-close {
  display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px;
  background: transparent; border: 1px solid var(--border); color: var(--muted); cursor: pointer;
  transition: color .12s, border-color .12s;
}
.modal-close:hover { color: var(--text); border-color: var(--border-strong); }
.modal-drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 46px 20px; border: 2px dashed var(--border-strong); border-radius: 12px;
  text-align: center; color: var(--muted); transition: border-color .12s, background .12s;
}
.modal-drop.is-over { border-color: var(--accent); background: var(--accent-dim); }
.modal-drop-ic { color: var(--accent); }
.modal-drop-ic svg { width: 34px; height: 34px; }
.modal-drop-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-drop-sub { font-size: 12px; }
.modal-drop-sub code {
  font-family: var(--font-mono); color: var(--text);
  background: var(--panel); padding: 2px 6px; border-radius: 5px;
}
.modal-text { font-size: 13.5px; line-height: 1.5; color: var(--muted); margin: 4px 0 18px; }
.modal-text strong { color: var(--text); font-weight: 600; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.mbtn {
  height: 34px; padding: 0 16px; font-size: 13px; font-weight: 600;
  border-radius: 8px; cursor: pointer; border: 1px solid var(--border); transition: all .12s;
}
.mbtn--ghost { background: transparent; color: var(--muted); }
.mbtn--ghost:hover { color: var(--text); border-color: var(--border-strong); }
.mbtn--danger { background: #E0584F; color: #fff; border-color: #E0584F; }
.mbtn--danger:hover { background: #ec6b62; border-color: #ec6b62; }
.mbtn--go { background: var(--accent); color: #04130D; border-color: var(--accent); }
.mbtn--go:hover { background: var(--accent-bright); border-color: var(--accent-bright); }
.mbtn--go:disabled { opacity: 0.45; cursor: not-allowed; }

.modal--git { max-width: 920px; max-height: calc(100vh - 40px); display: flex; flex-direction: column; }
.modal--git .gsplit { grid-template-columns: 280px 1fr; min-height: 520px; flex: 1 1 auto; }
.modal--git .gmaster-list { max-height: none; overflow-y: auto; overflow-x: hidden; }
.gtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.gtab {
  display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px;
  font-size: 13px; font-weight: 600; color: var(--muted); background: transparent;
  border: none; border-bottom: 2px solid transparent; cursor: pointer; margin-bottom: -1px;
  transition: color .12s, border-color .12s;
}
.gtab:hover { color: var(--text); }
.gtab.is-active { color: var(--accent); border-bottom-color: var(--accent); }
.gtab-plus { display: grid; place-items: center; }
.gtab-plus svg { width: 13px; height: 13px; }
.gaddpane { max-width: 520px; margin: 0 auto; width: 100%; padding-top: 8px; }
.gadd-intro { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 0 0 18px; }
.gadd-intro code { font-family: var(--font-mono); color: var(--text); background: var(--panel); padding: 1px 5px; border-radius: 4px; }
.gmanage-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 320px; }
.gmanage-empty .mbtn { display: inline-flex; align-items: center; gap: 7px; }
.gmanage-empty .radd-plus svg { width: 14px; height: 14px; }
.modal-title-ic { display: inline-grid; place-items: center; color: var(--accent); margin-right: 7px; vertical-align: -3px; }
.gform { display: flex; flex-direction: column; gap: 12px; margin: 4px 0 18px; }
.grow { display: flex; gap: 12px; }
.grow .gfield { flex: 1 1 0; min-width: 0; }
.gfield { display: flex; flex-direction: column; gap: 5px; }
.glabel { font-size: 11.5px; font-weight: 600; color: var(--muted); }
.glabel em { font-style: normal; color: var(--faint); font-weight: 400; }
.ginput {
  height: 36px; padding: 0 11px; font-size: 13px; color: var(--text);
  background: var(--panel); border: 1px solid var(--border-strong); border-radius: 8px; outline: none;
  transition: border-color .12s;
}
.ginput::placeholder { color: var(--faint); }
.ginput:focus { border-color: var(--accent); }
.ginput.mono { font-family: var(--font-mono); font-size: 12px; }

.gphases { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.gphase {
  font-size: 11px; font-weight: 600; text-transform: capitalize; letter-spacing: 0.02em;
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); color: var(--faint);
}
.gphase.is-active { color: var(--accent); border-color: rgba(22,225,160,0.4); background: var(--accent-dim); }
.gphase.is-done { color: var(--muted); border-color: var(--border-strong); }
.glog {
  margin: 0 0 12px; max-height: 260px; overflow: auto;
  background: #06090b; border: 1px solid var(--border); border-radius: 8px;
  padding: 11px 13px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5;
  color: var(--muted); white-space: pre-wrap; word-break: break-word;
}
.gerror { color: #E0584F; font-size: 13px; margin: 0 0 12px; }
.gdone { color: var(--accent); font-size: 13px; margin: 0 0 12px; }
.gdone code, .gerror code { font-family: var(--font-mono); background: var(--panel); padding: 1px 6px; border-radius: 5px; }

.rstatus { display: grid; place-items: center; width: 14px; height: 14px; flex: 0 0 auto; }
.rdot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.rstatus--idle { color: var(--accent); }
.rstatus--building { color: var(--accent); }
.rstatus--error { color: #E0584F; }
.rbadge {
  flex: 0 0 auto; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
  padding: 2px 7px; border-radius: 5px; color: var(--accent); background: var(--accent-dim);
}
.rbadge--error { color: #E0584F; background: rgba(224,88,79,0.13); }
.rbadge--building { color: #FFD43B; background: rgba(255,212,59,0.13); }
.rk { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--faint); flex: 0 0 auto; }
.rerr { font-size: 11.5px; color: #E0584F; font-family: var(--font-mono); word-break: break-word; margin-top: 2px; }
.rart {
  font-family: var(--font-mono); font-size: 11px; color: #C7B6FF; text-decoration: none;
  background: rgba(168,139,250,0.12); border: 1px solid rgba(168,139,250,0.28);
  border-radius: 5px; padding: 2px 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.rart:hover { border-color: rgba(168,139,250,0.55); color: #E2D8FF; }
.gform-note { font-size: 12px; color: var(--muted); line-height: 1.5; margin: 2px 0 4px; }
.gform-note code { font-family: var(--font-mono); color: var(--text); background: var(--panel); padding: 1px 5px; border-radius: 4px; }

/* git runners: master (list) + detail (selected) layout */
.gsplit { display: grid; grid-template-columns: 240px 1fr; gap: 16px; min-height: 320px; margin-bottom: 14px; }
.gmaster { display: flex; flex-direction: column; gap: 8px; border-right: 1px solid var(--border); padding-right: 16px; min-width: 0; }
.gmaster-hd { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); }
.gmaster-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; overflow-x: hidden; max-height: 360px; flex: 1 1 auto; }
.gmaster-empty { font-size: 12px; color: var(--faint); padding: 6px 2px; }
.gmrow {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 8px 9px; border-radius: 8px; border: 1px solid transparent; background: transparent;
  cursor: pointer; min-width: 0; transition: background .12s, border-color .12s;
}
.gmrow:hover { background: var(--panel); }
.gmrow.is-active { background: var(--panel-hover); border-color: var(--border-strong); }
.gmrow-repo { font-size: 12.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.gmrow-dest { font-size: 10.5px; font-family: var(--font-mono); color: var(--faint); flex: 0 0 auto; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grgroup { display: flex; flex-direction: column; gap: 3px; }
.grgroup-hd {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  padding: 7px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent;
  cursor: pointer; min-width: 0; transition: background .12s;
}
.grgroup-hd:hover { background: var(--panel); }
.grgroup-caret { display: grid; place-items: center; flex: 0 0 auto; color: var(--muted); transition: transform .15s; }
.grgroup-caret svg { width: 12px; height: 12px; transform: rotate(90deg); }
.grgroup-caret.is-collapsed svg { transform: rotate(0deg); }
.grgroup-folder { display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); }
.grgroup-folder svg { width: 15px; height: 15px; }
.grgroup-name { font-size: 12.5px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.grgroup-gear svg { width: 12px; height: 12px; }
.grgroup-count {
  flex: 0 0 auto; font-size: 11px; font-weight: 700; font-family: var(--font-mono);
  color: var(--muted); background: var(--panel); border: 1px solid var(--border);
  border-radius: 9px; min-width: 20px; height: 18px; padding: 0 6px; display: grid; place-items: center;
}
.gmrow--nested { margin-left: 16px; padding: 6px 9px; }
.gadd-btn {
  display: inline-flex; align-items: center; gap: 7px; justify-content: center;
  padding: 8px 12px; font-size: 13px; font-weight: 600; color: var(--accent);
  background: var(--accent-dim); border: 1px solid rgba(22,225,160,0.3); border-radius: 8px; cursor: pointer;
  transition: background .12s, border-color .12s;
}
.gadd-btn:hover, .gadd-btn.is-active { border-color: rgba(22,225,160,0.55); }
.gadd-btn .radd-plus { display: grid; place-items: center; }
.gadd-btn .radd-plus svg { width: 14px; height: 14px; }

.gdetail { min-width: 0; }
.gdetail-empty { display: flex; flex-direction: column; gap: 10px; }
.gdetail-hint { font-size: 12.5px; color: var(--faint); }
.gdtl { display: flex; flex-direction: column; gap: 14px; }
.gdtl-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gdtl-repo { font-size: 15px; font-weight: 700; color: var(--text); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gdtl-repo:hover { color: var(--accent); }
.gdtl-fields { display: flex; flex-direction: column; gap: 9px; }
.gdtl-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gdtl-v { font-size: 12.5px; color: var(--text); font-family: var(--font-mono); word-break: break-all; }
.gdtl-artifacts { display: flex; flex-direction: column; gap: 6px; }
.gdtl-art-list { display: flex; flex-direction: column; gap: 4px; }
.gdtl-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.gdtl-actions .mbtn { display: inline-flex; align-items: center; gap: 7px; }
.gdtl-actions .mbtn svg { width: 14px; height: 14px; }

.gbuild { margin-bottom: 14px; }
.glog-close {
  margin-left: auto; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px;
  background: transparent; border: 1px solid var(--border); color: var(--muted); cursor: pointer;
}
.glog-close:hover { color: var(--text); border-color: var(--border-strong); }

/* bottom-left stack: progress toasts + resume card share one column so they never overlap */
.bl-stack {
  position: fixed; left: 22px; bottom: 56px; z-index: 90;
  display: flex; flex-direction: column; gap: 12px;
  width: 340px; max-width: calc(100vw - 44px);
  transition: left .16s ease, top .16s ease, bottom .16s ease;
}
/* while the Merkle graph modal is open, move the stack to the top-left so
   toasts appear just under the root copy button instead of bottom-left */
.bl-stack--graph { left: 22px; top: 64px; bottom: auto; }
/* upload progress toasts */
.toasts {
  display: flex; flex-direction: column; gap: 10px; width: 100%;
}
.toast {
  background: rgba(8,11,10,0.92); border: 1px solid var(--border); border-radius: 10px;
  padding: 11px 13px; backdrop-filter: blur(10px); box-shadow: 0 12px 32px -12px rgba(0,0,0,0.75);
}
@media (prefers-reduced-motion: no-preference) {
  .toast { animation: toast-in .18s ease-out; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
}
.toast--done { border-color: rgba(22,225,160,0.4); }
.toast--error { border-color: rgba(224,88,79,0.5); }
.toast-head { display: flex; align-items: center; gap: 9px; }
.toast-ic { display: grid; place-items: center; flex: 0 0 auto; width: 16px; height: 16px; color: var(--accent); }
.toast--error .toast-ic { color: #E0584F; }
.toast-label {
  font-size: 12.5px; font-weight: 600; color: var(--text); flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.toast-pct { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); flex: 0 0 auto; }
.toast--done .toast-pct { color: var(--accent); }
.toast--error .toast-pct { color: #E0584F; }
.toast-dest {
  margin-top: 5px; font-family: var(--font-mono); font-size: 11px; color: var(--accent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85;
}
.toast-current {
  margin-top: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.toast-track { margin-top: 9px; height: 4px; border-radius: 3px; background: var(--panel); overflow: hidden; }
.toast-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .15s ease; box-shadow: 0 0 8px var(--accent-glow); }
.toast-err { margin-top: 7px; font-size: 11px; color: #E0584F; font-family: var(--font-mono); word-break: break-word; }
.spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--accent-dim); border-top-color: var(--accent);
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* drag-drop overlay */
.dropzone {
  position: absolute; inset: 8px; z-index: 30;
  display: grid; place-items: center;
  background: rgba(0,0,0,0.78); backdrop-filter: blur(3px);
  border: 2px dashed var(--accent); border-radius: 14px;
}
.dropzone-inner {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--accent); font-weight: 600; font-size: 14px;
}
.dropzone-inner svg { width: 30px; height: 30px; }
.dropzone-inner code {
  font-family: var(--font-mono); color: var(--text);
  background: var(--panel); padding: 2px 7px; border-radius: 5px;
}

.crumbs {
  display: flex; align-items: center; gap: 2px;
  flex: 1 1 auto; min-width: 0; overflow: hidden;
  padding-left: 4px;
}
.crumb-wrap { display: inline-flex; align-items: center; gap: 2px; }
.crumb {
  display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 9px;
  font-size: 13px; font-weight: 600; color: var(--muted);
  background: transparent; border: none; border-radius: 6px; cursor: pointer;
  transition: color .12s, background .12s; max-width: 260px; overflow: hidden;
}
.crumb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb-hash { font-family: var(--font-mono); font-size: 10.5px; font-weight: 400; color: var(--faint); flex: 0 0 auto; }
.crumb:hover .crumb-hash, .crumb.is-current .crumb-hash { color: var(--muted); }
.crumb.is-first .crumb-name { color: var(--accent); }
.crumb:hover { color: var(--text); background: var(--panel); }
.crumb.is-current { color: var(--text); }
.sep { display: grid; place-items: center; color: var(--faint); }

.colhead {
  display: grid; grid-template-columns: var(--gridcols); align-items: center; gap: 16px;
  padding: 9px 22px; border-bottom: 1px solid var(--border);
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; color: var(--faint);
}
.col-size { text-align: right; }
.col-hash { text-align: left; }
.col-act { text-align: center; }

.rows { flex: 1; padding-bottom: 96px; /* clear the fixed upload button + sticky statusbar */ }
.row {
  display: grid; grid-template-columns: var(--gridcols); align-items: center; gap: 16px;
  width: 100%; min-height: 42px; padding: 0 22px; text-align: left;
  background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.04);
  font-family: var(--font-sans); color: var(--text); position: relative;
}
button.row { appearance: none; cursor: pointer; }
.row:hover { background: var(--panel); }

.cell-name { display: flex; align-items: center; gap: 11px; min-width: 0; }
.file-link, .folder-link { text-decoration: none; color: inherit; cursor: pointer; }
.folder-link { background: none; border: none; padding: 0; text-align: left; font: inherit; }
.file-link:hover .nm, .folder-link:hover .nm { color: var(--accent); }
.file-link:hover .ic--file, .folder-link:hover .ic--folder { filter: brightness(1.2); }
.ic { display: grid; place-items: center; flex: 0 0 auto; }
.ic--folder { color: var(--accent); }
.ic--runner { color: #A88BFA; }
.runner-dot {
  display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto;
  height: 18px; padding: 0 6px 0 5px; border-radius: 9px;
  color: #C7B6FF; background: rgba(168,139,250,0.14); border: 1px solid rgba(168,139,250,0.3);
  cursor: pointer; transition: background .12s, border-color .12s;
}
.runner-dot:hover { background: rgba(168,139,250,0.22); border-color: rgba(168,139,250,0.5); }
.runner-dot-n { font-size: 11px; font-weight: 700; font-family: var(--font-mono); line-height: 1; }
/* status variants: idle = violet (default above), error = red, building = amber */
.runner-dot--error { color: #FF8A80; background: rgba(224,88,79,0.16); border-color: rgba(224,88,79,0.45); }
.runner-dot--error:hover { background: rgba(224,88,79,0.26); border-color: rgba(224,88,79,0.7); }
.runner-dot--building { color: #FFD98A; background: rgba(255,200,80,0.14); border-color: rgba(255,200,80,0.4); }
.runner-dot--building:hover { background: rgba(255,200,80,0.24); border-color: rgba(255,200,80,0.65); }
.gear-spin { display: inline-flex; align-items: center; flex: 0 0 auto; color: var(--accent); }
.gear-spin svg { animation: gear-rotate 1.8s linear infinite; }
@keyframes gear-rotate { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .gear-spin svg { animation: none; } }
.ic--runner svg { width: 16px; height: 16px; }
.row--runner .nm { color: #C9B8FF; }

.runner-badge {
  display: inline-flex; align-items: center; gap: 4px; margin-left: 9px; flex: 0 0 auto;
  height: 19px; padding: 0 7px 0 6px; border-radius: 5px; cursor: pointer;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  color: #C9B8FF; background: rgba(168,139,250,0.13); border: 1px solid rgba(168,139,250,0.32);
  transition: background .12s, border-color .12s;
}
.runner-badge:hover { background: rgba(168,139,250,0.22); border-color: rgba(168,139,250,0.55); }
.runner-badge svg { width: 11px; height: 11px; }
.runner-badge .recalc-spin { width: 9px; height: 9px; border-top-color: #C9B8FF; border-color: rgba(168,139,250,0.3); border-top-color: #C9B8FF; }
.runner-badge--building { color: var(--accent); background: var(--accent-dim); border-color: rgba(22,225,160,0.4); }
.runner-badge--error { color: #E0584F; background: rgba(224,88,79,0.12); border-color: rgba(224,88,79,0.4); }
.ic--file { color: var(--muted); }
.nm { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row--dir .nm { font-weight: 600; }

.meta { color: var(--muted); font-family: var(--font-mono); font-size: 12px; }
.col-size.meta { text-align: right; }
.hash {
  font-family: var(--font-mono); font-size: 12px; color: var(--muted); letter-spacing: 0.03em;
  padding: 2px 8px; border-radius: 5px; background: var(--panel); justify-self: start; white-space: nowrap;
}
.hash.recalc {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--accent); background: var(--accent-dim);
}
.recalc-spin {
  width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto;
  border: 1.5px solid rgba(22,225,160,0.25); border-top-color: var(--accent);
  animation: spin .7s linear infinite;
}

.col-act.actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.act-btn {
  display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px;
  color: var(--muted); text-decoration: none; cursor: pointer;
  background: transparent; border: 1px solid transparent;
  transition: color .12s, border-color .12s, background .12s;
}
.act-btn:hover { color: var(--accent); border-color: rgba(22,225,160,0.35); background: var(--accent-dim); }
.act-btn.act-danger:hover { color: #E0584F; border-color: rgba(224,88,79,0.4); background: rgba(224,88,79,0.1); }

.row.is-ghost { opacity: 0.6; }
.row.is-ghost .nm { color: var(--muted); font-style: italic; }
.row.is-ghost .cell-name { cursor: default; }
@media (prefers-reduced-motion: no-preference) {
  .row.is-ghost { animation: ghost-pulse 1.6s ease-in-out infinite; }
  @keyframes ghost-pulse { 0%,100% { opacity: 0.45; } 50% { opacity: 0.72; } }
}

.folder-empty { padding: 60px 22px; color: var(--faint); font-style: italic; font-size: 13px; }

/* flash — the Merkle ripple */
@media (prefers-reduced-motion: no-preference) {
  .row.is-flash { animation: flash 1.4s ease-out; }
  .row.is-flash .hash { animation: flash-hash 1.4s ease-out; }
  @keyframes flash {
    0% { background: rgba(22,225,160,0.18); box-shadow: inset 3px 0 0 var(--accent); }
    100% { background: transparent; box-shadow: inset 3px 0 0 transparent; }
  }
  @keyframes flash-hash { 0% { color: var(--accent-bright); background: var(--accent-dim); } 100% { color: var(--muted); } }
}
@media (prefers-reduced-motion: reduce) {
  .row.is-flash { box-shadow: inset 3px 0 0 var(--accent); }
  .row.is-flash .hash { color: var(--accent-bright); }
}

/* status bar */
.statusbar {
  display: flex; align-items: center; gap: 18px;
  padding: 8px 22px; border-top: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 11.5px; color: var(--muted);
  position: sticky; bottom: 0; background: rgba(0,0,0,0.72); backdrop-filter: blur(14px);
}
.sb-version { color: var(--faint); margin-left: auto; }
.sb-disk { position: relative; display: inline-flex; align-items: center; outline: none; }
.sb-disk-chip {
  display: inline-flex; align-items: center; gap: 5px; cursor: default;
  color: var(--muted); transition: color .12s;
}
.sb-disk:hover .sb-disk-chip, .sb-disk:focus-visible .sb-disk-chip { color: var(--text); }
.sb-disk-pct { font-size: 11.5px; }
.sb-disk.is-low .sb-disk-chip { color: #E0584F; }
.sb-disk-pop {
  position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%) translateY(4px);
  display: flex; flex-direction: column; gap: 6px; width: 180px; padding: 10px 11px;
  background: rgba(8,11,10,0.97); border: 1px solid var(--border-strong); border-radius: 9px;
  box-shadow: 0 14px 36px -12px rgba(0,0,0,0.8); backdrop-filter: blur(10px);
  opacity: 0; pointer-events: none; transition: opacity .14s, transform .14s; z-index: 30;
}
.sb-disk:hover .sb-disk-pop, .sb-disk:focus-visible .sb-disk-pop { opacity: 1; transform: translateX(-50%) translateY(0); }
.sb-pop-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.sb-pop-k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--faint); }
.sb-pop-v { font-size: 11.5px; color: var(--text); }
.sb-bar { width: 100%; height: 6px; border-radius: 3px; background: var(--panel); overflow: hidden; border: 1px solid var(--border); margin-top: 2px; }
.sb-bar-fill { display: block; height: 100%; background: var(--accent); transition: width .4s ease; }
.sb-disk.is-low .sb-bar-fill { background: #E0584F; }

/* empty / loading */
.empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 90px 20px; gap: 6px; }
.empty-glyph {
  display: grid; place-items: center; width: 60px; height: 60px; margin-bottom: 14px;
  color: var(--accent); border-radius: 16px; border: 1px solid rgba(22,225,160,0.3); background: var(--accent-dim);
  box-shadow: 0 0 40px -8px var(--accent-glow);
}
@media (prefers-reduced-motion: no-preference) {
  .empty-glyph { animation: float 3.5s ease-in-out infinite; }
  @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
}
.empty-title { font-size: 15px; font-weight: 600; color: var(--text); margin: 0; }
.empty-sub { font-size: 13px; color: var(--muted); margin: 0; max-width: 340px; }

.svd a:focus-visible, .svd button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

@media (max-width: 620px) {
  .svd { --gridcols: minmax(0,1fr) 118px; }
  .col-size, .col-hash { display: none; }
  .fp-label { display: none; }
  .fab-wrap { right: 18px; bottom: 44px; }
  .bl-stack { left: 14px; right: 14px; bottom: 44px; width: auto; }
}
`;
