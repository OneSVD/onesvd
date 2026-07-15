<div align="center">

# OneSVD

**The open-source artifact store for DevOps teams.**

Give every file a cryptographic fingerprint. When content or structure changes, hash workers
recompute its integrity hash — so you can verify exactly what shipped, down to the last byte.

[Docs](https://onesvd.com/docs) · [Website](https://onesvd.com) · [Quickstart](#quickstart)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

---

## Install

Self-host a fully featured node on your own hardware (Ubuntu Linux):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.onesvd.com | bash
```

That's it — no license keys, no limits, and your data never leaves your machine.

## What it is

OneSVD treats storage like configuration management. Every file you store is fingerprinted with a
cryptographic hash; change a single byte and the fingerprint changes too. Files roll up into a
Merkle tree where **every node is a hash and the root certifies all of it** — so at any moment you
can prove your builds, backups, and releases are exactly what you saved.

It slots into the workflows your build and release tooling already use: point your pipeline's
output or a backup job at the node, and it's fingerprinted automatically — no API call, no upload
step.

## How it works

1. **Anything that lands in `ONESVD_ROOT` is picked up and fingerprinted** — no matter how it got
   there. A drag-and-drop upload, an `scp`, a `cp`/`mv`/`rsync`, or a build script writing output
   all work identically. The watcher is the source of truth; the web UI just shows you what it
   already sees.
2. **Hash workers recompute the integrity hash** whenever content or structure changes, and update
   the tree.
3. **The root hash certifies the whole tree** — browse it, generate access links, or replicate
   artifacts to another node.

## Quickstart

```bash
# 1. Install the node
curl --proto '=https' --tlsv1.2 -sSf https://sh.onesvd.com | bash

# 2. Drop a file into the watched root — it's fingerprinted on arrival
touch "$ONESVD_ROOT/test_file.txt"

# 3. Open the web client to browse the tree
open http://localhost:7777
```

See the [Quickstart guide](https://onesvd.com/docs/getting-started/quickstart) for the full walk-through.

## Build runners

Connect a repository and OneSVD's built-in runners take it from there — clone, build, and store the
results as a verified part of your tree. Every commit produces an artifact you can trace back to the
exact source it came from. No separate CI server to wire up. See
[Git runners](https://onesvd.com/docs/guides/git-runners).

## Verifying content

The hashing rule is small enough to hold in your head — and to reimplement anywhere:

- **File** — `sha256(file bytes)`.
- **Directory** — `sha256` of its children's hex hashes, **sorted ascending and concatenated**.
  Fixed-width hex means plain string order *is* numeric order.
- **Empty directory** — `sha256("")` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- **Names are not part of the hash.** A OneSVD hash identifies *content*: renaming a file or folder
  never changes any hash, while flipping a single byte changes every hash up to the root.

### Test vector

A directory containing one file with the bytes `hello` (no newline) and one empty subdirectory:

| Node | sha256 |
| --- | --- |
| file `hello` | `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824` |
| empty subdirectory | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| **root** = sha256 of the two hashes above, sorted (`2cf2…` < `e3b0…`) and concatenated | `a7714b14e55f7fbfc19131515793dda1ffc3b99831c4f7fcf2ce166efaa9d1ec` |

Reproduce it in any shell:

```bash
mkdir -p vec/empty && printf 'hello' > vec/file
./onesvd-hash.sh vec
# a7714b14e55f7fbfc19131515793dda1ffc3b99831c4f7fcf2ce166efaa9d1ec
```

### onesvd-hash.sh

[`onesvd-hash.sh`](onesvd-hash.sh) is a standalone verifier — bash + python3, no OneSVD install
required. Run it against any folder, on any machine, and compare the result with the root hash shown
in the web UI (or with another node's output) to prove two folders hold identical content:

```bash
./onesvd-hash.sh <folder>       # print the root hash
./onesvd-hash.sh -t <folder>    # print the hash of every entry (a tree)
./onesvd-hash.sh -j <folder>    # print the tree as JSON
```

On an installed node the CLI fronts the same script, defaulting to the watched directory:

```bash
onesvd hash                     # root hash of $ONESVD_ROOT
onesvd hash -t                  # every entry
onesvd hash /some/other/folder  # any folder
```

## Architecture

OneSVD is a single installable product made of three cooperating pieces:

| Component | Role | Default port | Env var |
| --- | --- | --- | --- |
| **Watcher** (Go) | Watches `ONESVD_ROOT`, fingerprints files, maintains the tree | — | `ONESVD_ROOT` |
| **Hub** (Node) | WebSocket + HTTP API the clients talk to | `4000` | `ONESVD_HUB_PORT` |
| **Hub ingest** (loopback) | Internal ingest channel between watcher and hub | `4001` | `ONESVD_INGEST_PORT` |
| **Web client** (Next.js) | Browse the tree, manage access, share links | `7777` | `ONESVD_FRONTEND_PORT` |

Override any port with its environment variable before installing. If a port is already in use by
something other than OneSVD, the installer stops and tells you which one.

## Windows installation (WSL2)

OneSVD runs on Linux; on Windows, install it inside WSL2.

1. **Install WSL2 with Ubuntu** — in an Administrator PowerShell, then reboot and set up your Ubuntu
   user:

   ```powershell
   wsl --install
   ```

2. **Enable systemd** so OneSVD's services run. Inside Ubuntu, add to `/etc/wsl.conf`:

   ```ini
   [boot]
   systemd=true
   ```

   then `wsl --shutdown` from PowerShell and reopen Ubuntu. (Recent WSL builds enable systemd by
   default — run `systemctl` first; if it works, skip this step.)

3. **Install OneSVD** inside Ubuntu, exactly as on a native node:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.onesvd.com | bash
   ```

4. Open `http://localhost:7777` in a Windows browser.

## LAN access from WSL2

If LAN devices can't reach OneSVD at `http://<host-ip>:7777`, Windows likely needs inbound firewall
rules for the two ports. In an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "OneSVD 7777" -Direction Inbound -LocalPort 7777 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "OneSVD 4000" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
```

Both ports are needed — the UI loads from `7777` and then talks to the hub on `4000`.

## Documentation

Full docs live at **[onesvd.com/docs](https://onesvd.com/docs)**:

- **Getting started** — Introduction, Install on Ubuntu, Quickstart, Configuration
- **Concepts** — The Merkle tree, Content addressing, Nodes & the hub
- **Guides** — Git runners, Uploading files, Archiving & recovery, Access & sharing
- **Reference** — Environment variables, CLI

## Contributing

Contributions are welcome. Please open an issue to discuss substantial changes before sending a pull
request, and make sure existing checks pass.

## License

Licensed under the [Apache License 2.0](LICENSE).
