#!/usr/bin/env bash
#
# onesvd-hash — compute the OneSVD Merkle root hash of a folder, offline.
#
# Reproduces the OneSVD watcher's hashing exactly, so the result can be compared
# against the root hash shown in the OneSVD UI (or another machine's output) to
# verify that two folders hold identical content.
#
#   file hash       = sha256(file bytes)
#   directory hash  = sha256(child_hash_1 || child_hash_2 || ...)
#                     the children's hex hashes sorted ascending (numeric == string
#                     order for fixed-width hex) and concatenated; an empty
#                     directory hashes the empty string. Names are not part of the
#                     hash — it identifies content only, so renames don't change it.
#
# Usage:
#   ./onesvd-hash.sh <folder>          # print the root hash
#   ./onesvd-hash.sh -t <folder>       # print the hash of every entry (a tree)
#   ./onesvd-hash.sh -j <folder>       # print the tree as JSON
#
set -euo pipefail

TREE=0
JSON=0
while getopts ":tjh" opt; do
  case "$opt" in
    t) TREE=1 ;;
    j) JSON=1 ;;
    h) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,20p'; exit 0 ;;
    \?) echo "onesvd-hash: unknown option -$OPTARG" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

if [ $# -ne 1 ]; then
  echo "usage: $(basename "$0") [-t|-j] <folder>" >&2
  exit 2
fi

ROOT=$1
if [ ! -d "$ROOT" ]; then
  echo "onesvd-hash: not a directory: $ROOT" >&2
  exit 1
fi

for dep in sha256sum python3; do
  command -v "$dep" >/dev/null 2>&1 || { echo "onesvd-hash: missing required tool: $dep" >&2; exit 1; }
done

# The hashing itself is done in python3 (present on any stock Ubuntu/WSL box):
# a shell-only version can't reproduce Go's JSON escaping or handle newlines in
# filenames safely, and getting those wrong silently changes the hash.
python3 - "$ROOT" "$TREE" "$JSON" <<'PY'
import hashlib, json, os, sys

root, want_tree, want_json = sys.argv[1], sys.argv[2] == "1", sys.argv[3] == "1"
CHUNK = 1 << 20

def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()

out = []

def walk(path, rel):
    """Returns the node's sha256. Mirrors the worker: files by content, dirs by
    the concatenation of their children's hashes sorted ascending."""
    if os.path.islink(path) or not os.path.isdir(path):
        sha = hash_file(path)
        if want_tree or want_json:
            out.append({"path": rel, "type": "file", "sha256": sha})
        return sha

    try:
        names = os.listdir(path)
    except OSError as e:
        print(f"onesvd-hash: cannot read {path}: {e}", file=sys.stderr)
        names = []

    hashes = []
    for name in names:
        child = os.path.join(path, name)
        child_rel = name if rel == "." else f"{rel}/{name}"
        hashes.append(walk(child, child_rel))

    # the worker folds children in ascending hash order; fixed-width hex means
    # plain string sort IS the numeric sort. Empty dir → sha256 of nothing.
    hashes.sort()
    sha = hashlib.sha256("".join(hashes).encode("ascii")).hexdigest()
    if want_tree or want_json:
        out.append({"path": rel, "type": "directory", "sha256": sha})
    return sha

root_sha = walk(root, ".")

if want_json:
    print(json.dumps({"root": root_sha, "nodes": sorted(out, key=lambda n: n["path"])}, indent=2))
elif want_tree:
    for n in sorted(out, key=lambda n: n["path"]):
        mark = "d" if n["type"] == "directory" else "f"
        print(f'{n["sha256"]}  {mark}  {n["path"]}')
else:
    print(root_sha)
PY
