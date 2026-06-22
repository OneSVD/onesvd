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
curl --proto '=https' --tlsv1.2 -sSf https://sh.onesvd.com | sh

# 2. Drop a file into the watched root — it's fingerprinted on arrival
cp ./build.tar.gz "$ONESVD_ROOT/"

# 3. Open the web client to browse the tree
open http://localhost:7777
```

See the [Quickstart guide](https://onesvd.com/docs/getting-started/quickstart) for the full walk-through.

## Build runners

Connect a repository and OneSVD's built-in runners take it from there — clone, build, and store the
results as a verified part of your tree. Every commit produces an artifact you can trace back to the
exact source it came from. No separate CI server to wire up. See
[Git runners](https://onesvd.com/docs/guides/git-runners).

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
