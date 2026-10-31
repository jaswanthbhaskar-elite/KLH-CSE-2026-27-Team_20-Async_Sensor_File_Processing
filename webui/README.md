# Web console for the Asynchronous File Processing Server

A React front end plus a small Node bridge, so the C server runs as a background service on Ubuntu
and you use it from a browser on **http://localhost:3000**.

```
 Browser ──HTTP/JSON──▶  Node bridge (port 3000)  ──TCP text protocol──▶  C server (port 8080)
 React app               serves the UI + /api/*        READ / WRITE / STATS / RESET / BENCH*
```

Your `server.c` is **not modified**. Every button click becomes one ordinary request to port 8080.

## Install as a background service (recommended)

Unzip this add-on into your project folder (the one that contains `server.c`), then:

```bash
sudo apt install -y build-essential nodejs     # Node 16 or newer; on Ubuntu 22.04 see the note below
sudo ./deploy/install.sh async                 # or: sudo ./deploy/install.sh sync
```

This compiles the server, installs it to `/opt/afps`, creates a locked-down `afps` user, and starts two
systemd services that **restart on failure and start on boot**. Files you write are stored in
`/var/lib/afps/data`. Open `http://localhost:3000` (the installer also prints your LAN address).

| Task | Command |
|---|---|
| Status | `systemctl status afps-server afps-web` |
| Live logs | `journalctl -u afps-server -f` and `journalctl -u afps-web -f` |
| Restart | `sudo systemctl restart afps-server afps-web` |
| Switch sync/async | `sudo ./deploy/install.sh sync` (re-running is safe) |
| Remove | `sudo ./deploy/uninstall.sh` (add `--purge` to delete stored files too) |

Installer options: `--web-port 8088`, `--localhost-only`, `--expose-raw-port`, `--no-systemd`, `--print-units`.

> Ubuntu 22.04's apt `nodejs` is version 12 (too old). Use
> `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`.
> Ubuntu 24.04's apt version (18) works.

## Try it without installing anything

```bash
./deploy/run-dev.sh async      # builds the server, starts both programs, Ctrl+C stops them
```

## What the page does

- **Live statistics**: polls `STATS` every second: queue length, completed/failed, latency, throughput, with sparklines.
  Shows a clear "not running" state and recovers by itself when the server comes back.
- **Files**: `WRITE` and `READ` a file, with the server's reply and timing. **Large-file benchmark** uses `BENCHWRITE`/`BENCHREAD` (up to 16 MB).
- **Burst test**: N writes then N reads with a chosen number in flight, drawn as a timeline of every request.
- **Recent activity**: every request made through the console.

## Things worth knowing

- **Protocol limits come from `server.c`**, and the UI enforces them: content is a single line (a newline ends the request),
  and a whole request is at most 1,023 bytes, so a `READ` returns at most 1,023 bytes. There is no list or delete command.
- **File names are validated by the bridge** (letters, digits, `.`, `-`, `_`). The C server passes names straight to `open()`;
  sending `WRITE ../x data` directly to port 8080 writes outside its folder. Because of that, the installer restricts the C server
  to loopback (`IPAddressAllow=localhost`) so only the bridge can reach it. Use `--expose-raw-port` if you need your
  original `client` to work from other machines.
- **The web console has no login.** It listens on all interfaces by default, so anyone on your network can write files into the
  data folder. Use `--localhost-only` (and an SSH tunnel: `ssh -L 3000:localhost:3000 you@server`) or a firewall rule
  (`sudo ufw allow from 192.168.1.0/24 to any port 3000`) on shared networks.
- **Burst tests and the listen backlog.** `server.c` calls `listen(fd, 10)`. If more than about 10 connections arrive at the same instant,
  the extras wait for a TCP retry (one second). That is why the burst test keeps 8 requests in flight by default. Raise it
  to see the effect on the timeline.
- The bridge times a request from connect to close; the server's own latency (in Live statistics) starts when a worker picks it up.

## HTTP API (what the React app calls)

| Method and path | Body | Sends to the server |
|---|---|---|
| `GET /api/stats` |  | `STATS`, returned as JSON |
| `GET /api/activity?since=ID` |  | (the bridge's own request log) |
| `POST /api/read` | `{"file"}` | `READ file` |
| `POST /api/write` | `{"file","content"}` | `WRITE file content` |
| `POST /api/reset` |  | `RESET` |
| `POST /api/bench` | `{"op":"write"\|"read","file","size"}` | `BENCHWRITE` / `BENCHREAD` |
| `POST /api/burst` | `{"pairs","concurrency"}` | many `WRITE` then `READ` |

You can call these from `curl` or any other language, for example:
`curl -X POST localhost:3000/api/write -H 'content-type: application/json' -d '{"file":"a.txt","content":"hi"}'`

## Configuration (environment variables for the bridge)

`WEB_PORT` (3000), `WEB_HOST` (0.0.0.0), `AFPS_HOST` (127.0.0.1), `AFPS_PORT` (8080), `STATIC_DIR`.

## Changing the front end

`webui/dist/` is prebuilt, so you don't need npm to run anything. To edit the React code in `webui/src/`:

```bash
cd webui && npm install && npm run build     # or: npm run dev   (rebuilds on save)
sudo ./deploy/install.sh async               # copies the new build into the service
```
