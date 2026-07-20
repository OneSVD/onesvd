package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	ChunkSize      = 4 * 1024 * 1024 // hash read buffer; larger reads matter a lot on 9P//drvfs mounts
	Debounce       = 3 * time.Second
	PubBuffer      = 256
	MinBackoff     = 500 * time.Millisecond
	MaxBackoff     = 10 * time.Second
	ReconcileEvery = 15 * time.Second // periodic disk rescan to catch events fsnotify dropped
)

// Root and IngestURL are env-driven so the same binary runs locally or in
// production. They're vars (not consts) because they're resolved at startup,
// but they're set once in init() and never mutated afterward.
//   ONESVD_ROOT        watched directory (default ./onesvd-root beside the cwd)
//   ONESVD_INGEST_PORT hub loopback ingest port (default 4001)
var (
	Root      = "" // absolute path to the watched directory; set in init()
	IngestURL = "" // hub ingest endpoint (loopback only); set in init()
)

func init() {
	r := os.Getenv("ONESVD_ROOT")
	if r == "" {
		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}
		r = filepath.Join(cwd, "onesvd-root")
	}
	if abs, err := filepath.Abs(r); err == nil {
		r = abs
	}
	Root = r

	port := os.Getenv("ONESVD_INGEST_PORT")
	if port == "" {
		port = "4001"
	}
	IngestURL = "http://127.0.0.1:" + port + "/ingest"
}

// Set ONESVD_DEBUG=1 for verbose per-event / per-change tracing.
var Debug = os.Getenv("ONESVD_DEBUG") == "1"

// The daemon writes nothing into Root, so nothing needs excluding by default.
var excludeNames = map[string]bool{}

func excluded(path string) bool { return excludeNames[filepath.Base(path)] }

// ---------------------------------------------------------------------------
// Tree types
// ---------------------------------------------------------------------------

type Node struct {
	name     string
	path     string // relative to Root; "." for root
	kind     string // "file" | "directory"
	sha256   string
	size     int64
	mtime    int64
	parent   *Node
	children map[string]*Node
}


type NodeWire struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"`
	Type     string      `json:"type"`
	SHA256   string      `json:"sha256"`
	Size     int64       `json:"size,omitempty"`
	MTime    int64       `json:"mtime,omitempty"`
	Children []*NodeWire `json:"children,omitempty"`
}

type Change struct {
	Op     string `json:"op"` // "upsert" | "delete"
	Path   string `json:"path"`
	Type   string `json:"type,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	Size   int64  `json:"size,omitempty"`
	MTime  int64  `json:"mtime,omitempty"`
}

type Message struct {
	Version uint64    `json:"version"`
	Kind    string    `json:"kind"` // "snapshot" | "patch" | "recalc"
	Tree    *NodeWire `json:"tree,omitempty"`
	Changes []Change  `json:"changes,omitempty"`
	Paths   []string  `json:"paths,omitempty"` // recalc: paths about to be rehashed
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

func logf(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }

func dbg(format string, args ...any) {
	if Debug {
		fmt.Fprintf(os.Stderr, "  · "+format+"\n", args...)
	}
}

// short returns the first 7 hex chars of a hash, matching the UI display.
func short(h string) string {
	if len(h) >= 7 {
		return h[:7]
	}
	if h == "" {
		return "·······"
	}
	return h
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

func rel(path string) string {
	if path == Root {
		return "."
	}
	r, err := filepath.Rel(Root, path)
	if err != nil {
		return path
	}
	return r
}

func abs(r string) string {
	if r == "." {
		return Root
	}
	return filepath.Join(Root, r)
}

func relDir(r string) string {
	d := filepath.Dir(r)
	if d == "." || d == "/" || d == "" {
		return "."
	}
	return d
}

func depth(r string) int {
	if r == "." {
		return 0
	}
	return strings.Count(r, "/") + 1
}

func parentChain(r string) []string {
	if r == "." {
		return []string{"."}
	}
	var out []string
	p := relDir(r)
	for {
		out = append(out, p)
		if p == "." {
			break
		}
		p = relDir(p)
	}
	return out
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

// sha256 of zero bytes — the hash of every empty file and every empty directory
const emptySHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func hashFile(path, rel string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	var size, done int64
	if rel != "" {
		if st, err := f.Stat(); err == nil {
			size = st.Size()
		}
	}
	h := sha256.New()
	buf := make([]byte, ChunkSize)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			_, _ = h.Write(buf[:n])
			if rel != "" && size > 0 {
				done += int64(n)
				postHashProg(rel, done, size)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// sortedChildren returns a directory's children in ascending hash order — the
// exact order recomputeDirHash folds them into the parent's hash. The wire uses
// this order so the UI's left-to-right layout is the true hashing order.
// Ties (identical hashes, i.e. duplicate content) break by name for determinism.
func sortedChildren(n *Node) []*Node {
	kids := make([]*Node, 0, len(n.children))
	for _, c := range n.children {
		kids = append(kids, c)
	}
	sort.Slice(kids, func(i, j int) bool {
		if kids[i].sha256 != kids[j].sha256 {
			return kids[i].sha256 < kids[j].sha256
		}
		return kids[i].name < kids[j].name
	})
	return kids
}

// recomputeDirHash: a directory's hash is the sha256 of its children's hashes
// sorted ascending and concatenated. sha256 hex strings are fixed-width, so
// numeric order and string order coincide — sort.Strings IS the numeric sort.
// Names and types are NOT part of the preimage: the hash identifies content only,
// so renaming a file (or moving it between siblings of the same parent) does not
// change the parent's hash. Duplicate children contribute once each (multiset).
func recomputeDirHash(n *Node) {
	hashes := make([]string, 0, len(n.children))
	for _, c := range n.children {
		if c.sha256 == "" { // a not-yet-hashed child makes this hash unknowable —
			n.sha256 = ""   // better to say "unknown" than publish an interim lie
			return
		}
		hashes = append(hashes, c.sha256)
	}
	sort.Strings(hashes)
	h := sha256.New()
	for _, hs := range hashes {
		_, _ = h.Write([]byte(hs))
	}
	n.sha256 = hex.EncodeToString(h.Sum(nil))
}

func toWire(n *Node) *NodeWire {
	w := &NodeWire{Name: n.name, Path: n.path, Type: n.kind, SHA256: n.sha256, Size: n.size, MTime: n.mtime}
	if n.kind == "directory" {
		for _, c := range sortedChildren(n) {
			w.Children = append(w.Children, toWire(c))
		}
	}
	return w
}

// ---------------------------------------------------------------------------
// Server (tree owner + publisher)
// ---------------------------------------------------------------------------

type Server struct {
	mu      sync.Mutex
	root    *Node
	index   map[string]*Node
	version uint64

	pubCh     chan Message
	pubResync int32 // atomic; 1 => next publish must be a full snapshot
}

func NewServer() *Server {
	return &Server{pubCh: make(chan Message, PubBuffer)}
}

func (s *Server) ensureDir(r string) *Node {
	if r == "." {
		return s.root
	}
	if n := s.index[r]; n != nil && n.kind == "directory" {
		return n
	}
	parent := s.ensureDir(relDir(r))
	name := filepath.Base(r)
	n := parent.children[name]
	if n == nil || n.kind != "directory" {
		n = &Node{name: name, path: r, kind: "directory", parent: parent, children: map[string]*Node{}}
		parent.children[name] = n
		s.index[r] = n
		dbg("new dir node %s", r)
	}
	return n
}

func (s *Server) upsertFile(r, digest string, size, mtime int64) *Node {
	parent := s.ensureDir(relDir(r))
	name := filepath.Base(r)
	n := parent.children[name]
	if n == nil || n.kind != "file" {
		n = &Node{name: name, path: r, kind: "file", parent: parent}
		parent.children[name] = n
		s.index[r] = n
	}
	n.sha256 = digest
	n.size = size
	n.mtime = mtime
	return n
}

func (s *Server) removeNode(r string) bool {
	n := s.index[r]
	if n == nil {
		return false
	}
	if n.parent != nil {
		delete(n.parent.children, n.name)
	}
	stack := []*Node{n}
	for len(stack) > 0 {
		x := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		delete(s.index, x.path)
		for _, c := range x.children {
			stack = append(stack, c)
		}
	}
	return true
}

// scan is PASS 1 of startup: a stat-only structure walk — no hashing. Even a
// vault with hundreds of thousands of files completes in seconds, so the UI
// gets the full layout (paths, names, sizes) immediately, with every hash
// unknown (""). Returns the file list for hashFill (pass 2) to work through.
func (s *Server) scan() ([]string, error) {
	postStatus("scanning", "")
	s.root = &Node{name: ".", path: ".", kind: "directory", children: map[string]*Node{}}
	s.index = map[string]*Node{".": s.root}

	var files []string
	var nDirs int
	err := filepath.WalkDir(Root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			logf("WARNING: walk %s: %v", path, err)
			return nil
		}
		if excluded(path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		r := rel(path)
		if r == "." {
			return nil
		}
		if d.IsDir() {
			s.ensureDir(r)
			nDirs++
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.Size() == 0 {
			// a zero-byte file's hash is definite without reading a thing —
			// same constant as an empty dir. Stamp it now, skip the fill queue.
			s.upsertFile(r, emptySHA, 0, info.ModTime().Unix())
			return nil
		}
		s.upsertFile(r, "", info.Size(), info.ModTime().Unix())
		files = append(files, r)
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Resolve every directory hash that doesn't depend on a file: an empty dir
	// (or a chain of them) has a definite hash — sha256 of nothing — right now.
	// Unknown-propagation leaves everything with unhashed file descendants at
	// "", so this settles exactly the dirs that CAN be settled. Without it,
	// empty dirs showed no hash until the whole fill finished, and their
	// ancestors sat at "hashing 100%" long after all their files were done.
	var dirs []*Node
	for _, n := range s.index {
		if n.kind == "directory" {
			dirs = append(dirs, n)
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return depth(dirs[i].path) > depth(dirs[j].path) })
	for _, n := range dirs {
		recomputeDirHash(n)
	}
	s.version = 1
	logf("Structure scan: %d files, %d dirs — skeleton published, hashing follows", len(files), nDirs)
	return files, nil
}

// hashFill is PASS 2: compute real hashes for every file the structure scan
// found, publishing progressively so hashes appear in the UI as they land
// instead of after a very long silent scan.
//
// Two hashing workers run concurrently — one for large files, one for the
// rest — so one enormous file can't stall the entire fill behind it. Workers
// only hash (no shared state); a single applier goroutine performs all tree
// mutation and publishing, keeping patch versions strictly ordered. Hashing
// defers while a client is uploading, same as ordinary change processing.
type hashedFile struct {
	rel, digest string
	size, mtime int64
}

func (s *Server) hashFill(files []string) {
	const largeThreshold = 256 << 20 // 256 MB: big enough to be worth its own lane
	var small, large []string
	s.mu.Lock()
	for _, r := range files {
		if n := s.index[r]; n != nil && n.size >= largeThreshold {
			large = append(large, r)
		} else {
			small = append(small, r)
		}
	}
	s.mu.Unlock()

	postStatus("starting", fmt.Sprintf("%d files to hash", len(files)))
	results := make(chan hashedFile, 64)
	var wg sync.WaitGroup
	worker := func(queue []string, lane string) {
		defer wg.Done()
		for _, r := range queue {
			for uploadsActive() {
				time.Sleep(5 * time.Second)
			}
			path := abs(r)
			info, err := os.Stat(path)
			if err != nil {
				continue // vanished since the structure scan; reconcile will settle it
			}
			postStatus("hashing", r)
			postLane(lane, r)
			digest, err := hashFile(path, r)
			if err != nil {
				logf("WARNING: hash %s: %v", r, err)
				continue
			}
			results <- hashedFile{r, digest, info.Size(), info.ModTime().Unix()}
		}
		postLane(lane, "") // lane drained — clear its pinned line
	}
	wg.Add(2)
	go worker(small, "small")
	go worker(large, "large")
	go func() { wg.Wait(); close(results) }()

	// single applier: batch results, mutate the tree, publish in version order
	batch := []hashedFile{}
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if msg := s.applyHashed(batch); msg != nil {
			s.publish(*msg)
		}
		batch = batch[:0]
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case fh, ok := <-results:
			if !ok {
				flush()
				s.finalizeDirs() // settle dirs no batch touched (e.g. empty ones)
				postStatus("finished", fmt.Sprintf("%d files hashed", len(files)))
				postStatus("idle", "")
				logf("Hash fill complete: %d files", len(files))
				return
			}
			batch = append(batch, fh)
			if len(batch) >= 250 {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

// finalizeDirs recomputes every directory hash bottom-up and publishes the
// changes. The fill batches only recompute ancestors of hashed FILES, so a
// directory with no file descendants — an empty dir, or a dir of empty dirs —
// would otherwise keep an unknown ("") hash forever.
func (s *Server) finalizeDirs() {
	s.mu.Lock()
	var dirs []string
	for p, n := range s.index {
		if n.kind == "directory" {
			dirs = append(dirs, p)
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return depth(dirs[i]) > depth(dirs[j]) })
	changed := map[string]*Node{}
	for _, d := range dirs {
		n := s.index[d]
		old := n.sha256
		recomputeDirHash(n)
		if n.sha256 != old {
			changed[d] = n
		}
	}
	if len(changed) == 0 {
		s.mu.Unlock()
		return
	}
	s.version++
	var changes []Change
	for p, n := range changed {
		changes = append(changes, Change{Op: "upsert", Path: p, Type: n.kind, SHA256: n.sha256, Size: n.size, MTime: n.mtime})
	}
	msg := Message{Version: s.version, Kind: "patch", Changes: changes}
	s.mu.Unlock()
	s.publish(msg)
}

// applyHashed is process()'s mutation phase without the stat/hash work — the
// fill workers already did that. Must only run from one goroutine at a time.
func (s *Server) applyHashed(files []hashedFile) *Message {
	s.mu.Lock()
	defer s.mu.Unlock()

	changed := map[string]*Node{}
	affected := map[string]bool{}
	for _, f := range files {
		n := s.upsertFile(f.rel, f.digest, f.size, f.mtime)
		changed[f.rel] = n
		for _, p := range parentChain(f.rel) {
			affected[p] = true
		}
	}

	dirs := make([]string, 0, len(affected))
	for d := range affected {
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool { return depth(dirs[i]) > depth(dirs[j]) })
	for _, d := range dirs {
		n := s.index[d]
		if n == nil || n.kind != "directory" {
			continue
		}
		old := n.sha256
		recomputeDirHash(n)
		if n.sha256 != old {
			changed[d] = n
		}
	}

	if len(changed) == 0 {
		return nil
	}
	s.version++
	var changes []Change
	for p, n := range changed {
		changes = append(changes, Change{Op: "upsert", Path: p, Type: n.kind, SHA256: n.sha256, Size: n.size, MTime: n.mtime})
	}
	return &Message{Version: s.version, Kind: "patch", Changes: changes}
}

// reconcile walks the actual disk tree and compares it to the in-memory index,
// returning every relative path that has drifted — i.e. that the fsnotify event
// stream missed. This is the safety net for events dropped under rapid creation
// (and for files dropped into a directory before its watch was added). It also
// re-adds watches for any directory it encounters (fsnotify Add is idempotent),
// which heals the "new subdir got files before we watched it" race. It does NOT
// mutate the tree itself — it just reports drift, which main feeds into the same
// dirty -> process -> publish pipeline as a normal event batch.
func (s *Server) reconcile(w *fsnotify.Watcher) map[string]bool {
	postStatus("reconciling", "")
	drift := map[string]bool{}

	// snapshot the current index paths under the lock (cheap; just keys + file meta)
	s.mu.Lock()
	onDisk := map[string]bool{} // will be filled during the walk
	type meta struct {
		kind        string
		size, mtime int64
	}
	known := make(map[string]meta, len(s.index))
	for r, n := range s.index {
		known[r] = meta{n.kind, n.size, n.mtime}
	}
	s.mu.Unlock()

	// walk disk: find creates (path unknown) and modifies (file size/mtime differ)
	_ = filepath.WalkDir(Root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if excluded(path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		r := rel(path)
		onDisk[r] = true
		if d.IsDir() {
			// idempotently (re)watch every directory; heals missed watch-adds
			_ = w.Add(path)
		}
		m, seen := known[r]
		if !seen {
			drift[r] = true // newly discovered path the watcher never registered
			return nil
		}
		if !d.IsDir() {
			info, e := d.Info()
			if e == nil && (info.Size() != m.size || info.ModTime().Unix() != m.mtime) {
				drift[r] = true // file changed but we never got (or lost) the event
			}
		}
		return nil
	})

	// find deletes: paths we still hold that are gone from disk
	for r := range known {
		if r == "." {
			continue
		}
		if !onDisk[r] {
			drift[r] = true
		}
	}
	return drift
}

// process applies a batch of dirty paths and returns a patch Message if
// anything changed (nil otherwise). Hashing happens before the lock.
func (s *Server) process(dirty map[string]bool) *Message {
	type fileUpdate struct {
		r, digest   string
		size, mtime int64
	}
	var files []fileUpdate
	var dirsExist []string
	var deletes []string

	for r := range dirty {
		path := abs(r)
		info, err := os.Stat(path)
		switch {
		case err != nil:
			deletes = append(deletes, r)
			dbg("stat miss -> delete  %s", r)
		case info.IsDir():
			dirsExist = append(dirsExist, r)
			dbg("stat dir            %s", r)
		default:
			postStatus("hashing", r)
			digest, err := hashFile(path, r)
			if err != nil {
				logf("WARNING: hash %s: %v", r, err)
				continue
			}
			files = append(files, fileUpdate{r, digest, info.Size(), info.ModTime().Unix()})
			dbg("stat file  %s  %s", short(digest), r)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	changed := map[string]*Node{}
	deleted := map[string]bool{}
	affected := map[string]bool{}

	for _, d := range deletes {
		if s.removeNode(d) {
			deleted[d] = true
		}
		for _, p := range parentChain(d) {
			affected[p] = true
		}
	}
	for _, r := range dirsExist {
		s.ensureDir(r)
		affected[r] = true
		for _, p := range parentChain(r) {
			affected[p] = true
		}
	}
	for _, f := range files {
		n := s.upsertFile(f.r, f.digest, f.size, f.mtime)
		changed[f.r] = n
		for _, p := range parentChain(f.r) {
			affected[p] = true
		}
	}

	dirs := make([]string, 0, len(affected))
	for d := range affected {
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool { return depth(dirs[i]) > depth(dirs[j]) })
	dbg("affected dirs (deep->shallow): %v", dirs)

	for _, d := range dirs {
		n := s.index[d]
		if n == nil || n.kind != "directory" {
			continue
		}
		old := n.sha256
		recomputeDirHash(n)
		if n.sha256 != old {
			changed[d] = n
			dbg("recompute %-20s %s -> %s  (%d children)", d, short(old), short(n.sha256), len(n.children))
		} else {
			dbg("recompute %-20s %s  (unchanged)", d, short(old))
		}
	}

	if len(changed) == 0 && len(deleted) == 0 {
		dbg("no net change; not publishing")
		return nil
	}

	s.version++
	var changes []Change
	for p, n := range changed {
		changes = append(changes, Change{Op: "upsert", Path: p, Type: n.kind, SHA256: n.sha256, Size: n.size, MTime: n.mtime})
	}
	for p := range deleted {
		changes = append(changes, Change{Op: "delete", Path: p})
	}
	postStatus("idle", "")
	return &Message{Version: s.version, Kind: "patch", Changes: changes}
}

func (s *Server) currentSnapshot() Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Message{Version: s.version, Kind: "snapshot", Tree: toWire(s.root)}
}

func (s *Server) rootHash() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.root.sha256
}

// ---------------------------------------------------------------------------
// Publisher: pushes snapshot/patches to the hub over HTTP, self-healing.
// ---------------------------------------------------------------------------

func (s *Server) publish(m Message) {
	select {
	case s.pubCh <- m:
	default:
		atomic.StoreInt32(&s.pubResync, 1)
		logf("publish buffer full; will resync")
	}
}

// publishRecalc sends a lightweight "recalc" signal listing every path whose
// hash is about to be recomputed (the dirty paths plus their parent chains up
// to root). It carries no version and never triggers a resync — it's a UI hint
// that lands before the real patch.
func (s *Server) publishRecalc(dirty map[string]bool) {
	set := map[string]bool{}
	for r := range dirty {
		set[r] = true
		for _, p := range parentChain(r) {
			set[p] = true
		}
	}
	if len(set) == 0 {
		return
	}
	paths := make([]string, 0, len(set))
	for p := range set {
		paths = append(paths, p)
	}
	// best-effort, non-blocking: if the buffer is full we just skip the hint
	select {
	case s.pubCh <- Message{Kind: "recalc", Paths: paths}:
	default:
	}
}

// ── watcher status telemetry ─────────────────────────────────────────────────
// Lightweight "what am I doing right now" reports for the UI, posted to the hub
// as {kind:"status"}. Fire-and-forget: status must never slow down or block the
// actual work. Rate-limited so hashing thousands of small files doesn't flood
// the hub — but a long-running hash of one big file stays visible the whole time.
var statusMu sync.Mutex
var statusLastSent time.Time
var statusLastState, statusLastDetail string
var statusPendingState, statusPendingDetail string
var statusPendingSet, statusFlushArmed bool

// uploadsActive asks the hub whether any client is actively uploading. The
// reconcile stat-walk competes with chunk appends for disk I/O, so the watcher
// defers its periodic rescan while uploads are in flight. Fail-open: if the hub
// is unreachable, reconcile proceeds as normal — the safety net must not depend
// on the hub being healthy.
var uploadsActiveClient = &http.Client{Timeout: 2 * time.Second}

func uploadsActive() bool {
	url := strings.TrimSuffix(IngestURL, "/ingest") + "/uploads-active"
	resp, err := uploadsActiveClient.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var r struct {
		Active int `json:"active"`
	}
	if json.NewDecoder(resp.Body).Decode(&r) != nil {
		return false
	}
	return r.Active > 0
}

// per-file hashing progress for the UI (row-level "hashing · N%"). Throttled to
// one post per 500ms; the final done==size post always goes through so the row
// can settle. Fire-and-forget like postStatus — never slows the hashing itself.
// per-lane "currently hashing" reports for the UI's pinned view. The small
// lane's files finish in milliseconds — byte-progress alone never pins them —
// so each lane names its current file explicitly. rel=="" clears the lane.
var laneMu sync.Mutex
var laneLast = map[string]time.Time{}

func postLane(lane, rel string) {
	laneMu.Lock()
	if rel != "" && time.Since(laneLast[lane]) < 500*time.Millisecond {
		laneMu.Unlock()
		return
	}
	laneLast[lane] = time.Now()
	laneMu.Unlock()
	body, _ := json.Marshal(map[string]string{"kind": "lane", "lane": lane, "path": rel})
	go func() {
		resp, err := http.Post(IngestURL, "application/json", bytes.NewReader(body))
		if err == nil {
			resp.Body.Close()
		}
	}()
}

var hashProgMu sync.Mutex
var hashProgLast = map[string]time.Time{} // per path: two concurrent hashers must not starve each other's updates

func postHashProg(rel string, done, size int64) {
	hashProgMu.Lock()
	if done < size && time.Since(hashProgLast[rel]) < 500*time.Millisecond {
		hashProgMu.Unlock()
		return
	}
	if done >= size {
		delete(hashProgLast, rel) // finished: no entry left behind
	} else {
		hashProgLast[rel] = time.Now()
	}
	hashProgMu.Unlock()
	body, _ := json.Marshal(map[string]interface{}{"kind": "hashprog", "path": rel, "done": done, "size": size})
	go func() {
		resp, err := http.Post(IngestURL, "application/json", bytes.NewReader(body))
		if err == nil {
			resp.Body.Close()
		}
	}()
}

func sendStatus(state, detail string) {
	body, _ := json.Marshal(map[string]string{"kind": "status", "state": state, "detail": detail})
	go func() {
		resp, err := http.Post(IngestURL, "application/json", bytes.NewReader(body))
		if err == nil {
			resp.Body.Close()
		}
	}()
}

// postStatus rate-limits to one report per 750ms — but a throttled update is
// DEFERRED, not dropped. Dropping meant a long file hash could leave the UI
// stuck showing whatever happened to post just before the throttle window.
func postStatus(state, detail string) {
	statusMu.Lock()
	if state == statusLastState && detail == statusLastDetail {
		statusMu.Unlock()
		return
	}
	// lifecycle markers (idle/starting/finished) are one-shot and must never be
	// throttled or deferred — only the high-frequency per-file states are
	throttleable := state == "hashing" || state == "scanning" || state == "reconciling"
	if throttleable && time.Since(statusLastSent) < 750*time.Millisecond {
		statusPendingState, statusPendingDetail, statusPendingSet = state, detail, true
		if !statusFlushArmed {
			statusFlushArmed = true
			wait := 750*time.Millisecond - time.Since(statusLastSent)
			time.AfterFunc(wait, flushStatus)
		}
		statusMu.Unlock()
		return
	}
	statusLastSent = time.Now()
	statusLastState, statusLastDetail = state, detail
	statusPendingSet = false
	statusMu.Unlock()
	sendStatus(state, detail)
}

func flushStatus() {
	statusMu.Lock()
	statusFlushArmed = false
	if !statusPendingSet {
		statusMu.Unlock()
		return
	}
	state, detail := statusPendingState, statusPendingDetail
	statusPendingSet = false
	if state == statusLastState && detail == statusLastDetail {
		statusMu.Unlock()
		return
	}
	statusLastSent = time.Now()
	statusLastState, statusLastDetail = state, detail
	statusMu.Unlock()
	sendStatus(state, detail)
}

func postMessage(url string, m Message) (uint64, error) {
	body, _ := json.Marshal(m)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("hub status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var r struct {
		Version uint64 `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return 0, err
	}
	return r.Version, nil
}

func (s *Server) publisherLoop() {
	backoff := MinBackoff
	for {
		var msg Message
		if atomic.SwapInt32(&s.pubResync, 0) == 1 {
			msg = s.currentSnapshot() // resync: send the whole tree
		} else {
			msg = <-s.pubCh
		}

		hubVer, err := postMessage(IngestURL, msg)
		if err != nil {
			logf("publish failed: %v (retry in %s)", err, backoff)
			atomic.StoreInt32(&s.pubResync, 1)
			time.Sleep(backoff)
			if backoff *= 2; backoff > MaxBackoff {
				backoff = MaxBackoff
			}
			continue
		}
		backoff = MinBackoff
		dbg("POST %-8s version=%d changes=%d -> hub reports version=%d",
			msg.Kind, msg.Version, len(msg.Changes), hubVer)

		if msg.Kind == "recalc" {
			continue // informational hint; no version, no resync check
		}

		s.mu.Lock()
		cur := s.version
		s.mu.Unlock()
		if hubVer < cur {
			logf("hub behind (hub=%d local=%d); resyncing", hubVer, cur)
			atomic.StoreInt32(&s.pubResync, 1)
		}
	}
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

func addWatches(w *fsnotify.Watcher) {
	n := 0
	_ = filepath.WalkDir(Root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && !excluded(path) {
			if err := w.Add(path); err != nil {
				logf("WARNING: cannot watch %s: %v", path, err)
			} else {
				n++
			}
		}
		return nil
	})
	logf("Watching %d directories", n)
}

func markDirtyInto(dirty map[string]bool, path string) {
	if (path != Root && !strings.HasPrefix(path, Root+string(os.PathSeparator))) || excluded(path) {
		return
	}
	dirty[rel(path)] = true
}

func addNewDir(w *fsnotify.Watcher, dir string, dirty map[string]bool) {
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if excluded(p) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if err := w.Add(p); err != nil {
				logf("WARNING: cannot watch %s: %v", p, err)
			}
		}
		markDirtyInto(dirty, p)
		return nil
	})
}

func resetTimer(t *time.Timer) {
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	t.Reset(Debounce)
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func main() {
	// ensure the watched root exists (first run on a fresh machine has no dir yet)
	if err := os.MkdirAll(Root, 0o755); err != nil {
		logf("WARNING: could not create root %s: %v", Root, err)
	}

	s := NewServer()
	files, err := s.scan()
	if err != nil {
		panic(err)
	}
	logf("OneSVD watcher started  (debug=%v)", Debug)
	logf("Root: %s", Root)
	logf("Hub ingest: %s", IngestURL)

	atomic.StoreInt32(&s.pubResync, 1)
	go s.publisherLoop()

	// pass 2: real hashes fill in progressively (the skeleton is already live)
	s.hashFill(files)
	logf("Initial rootHash=%s version=%d", s.root.sha256, s.version)

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		panic(err)
	}
	defer watcher.Close()
	addWatches(watcher)

	dirty := map[string]bool{}
	timer := time.NewTimer(Debounce)
	timer.Stop()

	reconcileTick := time.NewTicker(ReconcileEvery)
	defer reconcileTick.Stop()

	for {
		select {
		case event := <-watcher.Events:
			path := event.Name
			if excluded(path) {
				continue
			}
			dbg("EVENT %-18s %s", event.Op.String(), rel(path))
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(path); err == nil && info.IsDir() {
					dbg("new directory created; walking %s", rel(path))
					addNewDir(watcher, path, dirty)
				} else {
					markDirtyInto(dirty, path)
				}
			} else {
				markDirtyInto(dirty, path)
			}
			resetTimer(timer)

		case err := <-watcher.Errors:
			logf("WATCH ERROR: %v", err)

		case <-reconcileTick.C:
			// periodic safety net: catch anything the event stream missed.
			// Deferred while a client is uploading — the full stat walk competes
			// with chunk writes for disk I/O; the next tick after the upload
			// finishes picks the rescan back up.
			if uploadsActive() {
				dbg("reconcile deferred: upload in progress")
				continue
			}
			drift := s.reconcile(watcher)
			if len(drift) == 0 {
				postStatus("idle", "")
				continue
			}
			logf("RECONCILE found %d drifted path(s) the watcher missed", len(drift))
			for r := range drift {
				dirty[r] = true
			}
			resetTimer(timer)

		case <-timer.C:
			if len(dirty) == 0 {
				continue
			}
			// hashing reads files at full disk speed — while a client is
			// uploading, that starves the hub's chunk appends. Defer the batch
			// (keep accumulating) and retry after another debounce interval;
			// it processes the moment uploads go quiet. Fail-open like reconcile.
			if uploadsActive() {
				dbg("processing deferred: upload in progress (%d dirty)", len(dirty))
				resetTimer(timer)
				continue
			}
			batch := dirty
			dirty = map[string]bool{}
			if Debug {
				dbg("---- CYCLE: %d dirty path(s): %v", len(batch), keysOf(batch))
			}
			// Tell the frontend which paths are about to be recalculated, so it
			// can show "recalculating…" before the new hashes land.
			s.publishRecalc(batch)
			if msg := s.process(batch); msg != nil {
				s.publish(*msg)
				logf("UPDATED version=%d changes=%d rootHash=%s", msg.Version, len(msg.Changes), short(s.rootHash()))
				if Debug {
					for _, c := range msg.Changes {
						marker := "  "
						if c.Path == "." {
							marker = "->" // the root change the UI is supposed to consume
						}
						dbg("%s %-7s %-22s %s", marker, c.Op, c.Path, short(c.SHA256))
					}
				}
			}
		}
	}
}
