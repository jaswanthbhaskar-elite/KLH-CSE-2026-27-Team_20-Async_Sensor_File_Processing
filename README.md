# Asynchronous File Processing Server

A user-space Linux/C system-programming project: a multithreaded TCP file
server with a thread-safe request queue, a fixed worker pool, genuine POSIX
asynchronous I/O, a completion queue, per-request performance instrumentation,
and a controlled synchronous-vs-asynchronous experimental comparison.

---

## 1. Quick Start

```bash
# Build
make
# or manually:
gcc -o server server.c -lpthread -lrt
gcc -o client client.c

# Run (pick one)
./server sync
./server async

# In another terminal
./client
Enter request (example: READ test.txt): WRITE hello.txt Hello World
```

---

## 2. Project Overview

Most beginner OS-course socket servers handle one client, one operation, and
exit. This project instead builds up — stage by stage — a small but complete
concurrent server that a real system would recognize the shape of: clients
queue for a bounded pool of workers, workers hand file I/O to the kernel
asynchronously instead of blocking on it, completions are collected on a
second queue, and every request is timed so the system's own behavior can be
measured rather than assumed.

The problem it solves, narrowly: how do you serve many simultaneous file
READ/WRITE requests over TCP without either (a) blocking the whole server on
one slow client, or (b) spawning unbounded threads? The answer built here is
a bounded worker pool plus POSIX AIO, and the project's second half is
devoted to actually measuring whether that answer is faster than the naive
blocking alternative — under our own workloads, on our own machine, honestly
reported.

---

## 3. Architecture

### Asynchronous path (default)

```
Clients
   │
   ▼
TCP Server (accept loop)
   │
   ▼
Request Queue  (mutex + condition variable)
   │
   ▼
Worker Pool (4 fixed threads)
   │
   ▼
POSIX Async I/O   (aio_read / aio_write, SIGEV_THREAD)
   │
   ▼
Completion Queue  (mutex + condition variable)
   │
   ▼
Responder Thread
   │
   ▼
Clients
```

A worker dequeues a client, submits `aio_read()`/`aio_write()`, and
**immediately returns to the queue** for the next client — it never waits for
the file operation to finish. When the kernel completes the I/O, glibc spawns
a short-lived callback thread (`SIGEV_THREAD`) that records the result and
pushes it onto the completion queue. A single dedicated responder thread
drains that queue and sends the actual response bytes back to the client.

### Synchronous path (`./server sync`)

```
Client
   │
   ▼
Request Queue
   │
   ▼
Worker
   │
   ▼
Blocking File I/O   (plain read()/write())
   │
   ▼
Response
```

Same accept loop, same request queue, same worker pool, same stats
machinery — the only difference is that a worker calls blocking
`open()`/`read()`/`write()`/`close()` directly and is unavailable for the next
client until that call returns. The completion queue and responder thread
still exist and run in this mode; they are simply never fed any work.

Isolating that one variable (block-and-hold vs. submit-and-return) is the
entire point of Stage 9/10's synchronous mode — see §6.

---

## 4. OS Concepts Used — and Not Used

**Used, and why:**

| Concept | Where | Why it's here |
|---|---|---|
| File descriptors, `open`/`read`/`write`/`close` | everywhere | the basic unit of Linux file I/O |
| TCP sockets (`socket`/`bind`/`listen`/`accept`) | `main()` | the client-server transport |
| POSIX threads (`pthread_create`) | worker pool, responder | concurrency without one-process-per-client |
| `pthread_mutex` | request queue, completion queue, stats, ID counter | protects shared state from races |
| `pthread_cond` | request queue, completion queue | lets idle threads sleep instead of busy-waiting |
| Producer-consumer pattern | request queue (accept→worker), completion queue (AIO callback→responder) | the core synchronization pattern in this project |
| POSIX asynchronous I/O (`aio_read`/`aio_write`, `SIGEV_THREAD`) | async mode | genuine non-blocking file I/O, not "blocking I/O relabeled" |
| `clock_gettime(CLOCK_MONOTONIC)` | timestamps | correct way to measure durations on Linux |
| `/proc` | `monitor_server.sh` | live introspection of the running process |
| `strace` | debugging/demo | observing actual syscalls made |
| `gdb` | debugging/demo | inspecting live thread state |

**Deliberately NOT used, and why that's fine:**

| Concept | Why it's out of scope here |
|---|---|
| Semaphores | mutex+condvar already solve this project's synchronization needs; adding semaphores on top would be redundant, not additive |
| `epoll`/`select` | this project's concurrency comes from a worker-thread pool, not from single-threaded I/O multiplexing — a legitimate alternative design, not a gap |
| `io_uring` | more powerful but requires hand-built submission/completion ring buffers; POSIX AIO is the right complexity level for a beginner OS project with the same submit/complete conceptual shape |
| Process-level `fork()` | this server uses threads (shared memory) rather than processes; both are valid concurrency models, and we made a deliberate choice |
| Kernel modules / kernel modification | this is a user-space application by design, per the assignment scope |

---

## 5. Project Contribution / What Is New

This project does not claim to invent asynchronous I/O — `aio_read()` and
`aio_write()` are decades-old POSIX interfaces. Its contribution is:

> A lightweight Linux user-space implementation that integrates concurrent
> clients, synchronized request and completion queues, asynchronous file
> I/O, and performance instrumentation, together with a controlled
> synchronous-vs-asynchronous experiment under identical workloads.

Concretely, that means: (1) a working, understandable, from-scratch
implementation of the producer-consumer pattern applied twice (request
intake and completion delivery); (2) real per-request timing infrastructure
built with the correct clock source; and (3) an experimental harness
(`run_experiment.sh`, `analyze_results.sh`, `benchmark_filesize.sh`) that
lets the *same* server binary be measured in both modes, under the *same*
workload, so the sync-vs-async comparison is actually a controlled
experiment rather than an assumption.

---

## 6. Experimental Findings

**These numbers are illustrative, captured in a constrained sandbox
container while building this project — they are NOT your official
results.** Run the procedure in §7 on your own Ubuntu machine and report
those numbers. Different hardware, kernel versions, and disk types can and
do change the outcome, which is itself the point of running a controlled
experiment rather than assuming an answer.

### 6.1 Sample: 5 repeated runs per workload (this sandbox)

```
=========== BENCHMARK SUMMARY ===========

Workload   Mode    Runs   Mean Lat(ms)   Median Lat(ms) Max Lat(ms)    Mean Thr(req/s)
-------------------------------------------------------------------------------------
50         ASYNC   5      3.313          3.300          14.900         432.820
50         SYNC    5      0.027          0.024          0.157          422.631
100        ASYNC   5      3.737          3.827          14.572         403.747
100        SYNC    5      0.031          0.027          0.137          399.107
500        ASYNC   5      4.461          4.468          16.836         380.168
500        SYNC    5      0.031          0.028          0.173          387.768

==========================================
```

### 6.2 Sample: file-size sensitivity (10 WRITE + 10 READ per size, async mode)

```
size_label,size_bytes,avg_latency_ms,max_latency_ms,throughput_req_s
small,1024,2.148,6.615,570.931
medium,102400,0.619,4.099,592.925
large,1048576,3.751,9.053,456.640
```

### 6.3 How to read these particular numbers

In this sandbox, **synchronous mode showed lower average latency than
asynchronous mode** at every tested workload size. This is a legitimate,
explainable result, not a bug: on tiny, already-page-cached local files, the
fixed overhead of POSIX AIO's internal thread machinery (glibc spawns a
`SIGEV_THREAD` callback thread per completion) can exceed the cost of a
direct blocking syscall. Async I/O's advantage shows up when the I/O itself
is slow enough — larger files, real disk latency, network filesystems, or a
request volume that exceeds what a small fixed worker pool can hold open at
once — that overlapping it with other work actually pays for that overhead.

**Do not conclude "sync is always better" from this any more than you
should conclude "async is always better" without measuring.** That is
exactly the experimental question this project is built to let you answer
for your own machine and workload — see §7 to run it yourself.

---

## 7. Reproducing the Experiment

### 7.1 Fixed request-count workloads (Stage 10.1/10.2)

```bash
make
./run_experiment.sh sync 5      # 5 runs each of 50/100/500-request workloads
./run_experiment.sh async 5     # same, async mode

./analyze_results.sh results/sync_results.csv results/async_results.csv
./analyze_results.sh results/sync_results.csv results/async_results.csv --full
```

`run_experiment.sh` starts the server itself, sends `RESET` before every
run (so each run's numbers reflect only that run), fires the fixed
25-WRITE+25-READ / 50+50 / 250+250 workload, captures `STATS`, and appends
one row per run to `results/<mode>_results.csv` — never overwriting
previous rows. All workload files are written under `test_files/`, not the
project root.

### 7.2 File-size sensitivity (Stage 10.3)

```bash
./server async &
./benchmark_filesize.sh small  1024    10 results/filesize_async.csv
./benchmark_filesize.sh medium 102400  10 results/filesize_async.csv
./benchmark_filesize.sh large  1048576 10 results/filesize_async.csv
kill %1

./server sync &
./benchmark_filesize.sh small  1024    10 results/filesize_sync.csv
./benchmark_filesize.sh medium 102400  10 results/filesize_sync.csv
./benchmark_filesize.sh large  1048576 10 results/filesize_sync.csv
kill %1
```

This uses the `BENCHWRITE`/`BENCHREAD` protocol commands (see §10), which
generate/measure large payloads on the server side rather than transmitting
them over the network — the "clean benchmark-specific mechanism" for
testing sizes far beyond the 1 KB control-protocol buffer without changing
that protocol.

### 7.3 One-off single comparison (Stage 9, still available)

```bash
./server sync &
./benchmark.sh sync_stats.txt
kill %1

./server async &
./benchmark.sh async_stats.txt
kill %1

./compare_stats.sh sync_stats.txt async_stats.txt
```

---

## 8. Full Request Protocol Reference

| Command | Example | Counts as workload? | Notes |
|---|---|---|---|
| `READ <file>` | `READ test.txt` | Yes | returns file content |
| `WRITE <file> <data...>` | `WRITE test.txt hello world` | Yes | creates/overwrites; everything after the filename is data |
| `STATS` | `STATS` | **No** | returns the current performance snapshot |
| `RESET` | `RESET` | **No** | clears all workload stats (for repeated benchmark runs) |
| `BENCHWRITE <file> <size_bytes>` | `BENCHWRITE big.txt 1048576` | Yes (as WRITE) | server generates `<size_bytes>` of filler data itself; payload never crosses the network. Capped at 16 MB. |
| `BENCHREAD <file>` | `BENCHREAD big.txt` | Yes (as READ) | reads the whole file but replies with only a byte count, not the content |

---

## 9. Stage 11 — Linux Analysis and Debugging

### 9.1 Tracing with `strace`

**What it does:** `strace` intercepts and prints every system call a process
makes — the actual boundary between our C code and the kernel. **Why it's
useful here:** it lets you *prove*, rather than assert, that the server
really calls `socket`/`bind`/`listen`/`accept`, that `pthread_create` really
results in `clone3()` calls, and that `pthread_mutex`/`pthread_cond` are
implemented on top of the `futex` syscall.

```bash
strace -f ./server async
```
Use `-f` because the server is multithreaded — without it, `strace` only
follows the main thread and you'd miss everything workers and the
responder do.

What to look for (real output captured from this exact binary):
```
socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 3
bind(3, {sa_family=AF_INET, sin_port=htons(8080), ...}, 16) = 0
listen(3, 10)     = 0
clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|... }, 88) = 697   # worker 1
clone3({...}, 88) = 698                                        # worker 2
clone3({...}, 88) = 699                                        # worker 3
clone3({...}, 88) = 700                                        # worker 4
clone3({...}, 88) = 701                                        # responder
accept(3, NULL, NULL) = 4
```
After sending a `WRITE stracetest.txt Hello Strace`:
```
openat(AT_FDCWD, "stracetest.txt", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 6
futex(0x..., FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME, ...)   # a worker sleeping in dequeue()
futex(0x..., FUTEX_WAKE_PRIVATE, 1) = 1                              # enqueue() waking it up
```
Do not claim every syscall you see is *directly* written in `server.c` —
many (like the `openat` calls for `libc.so.6` at startup) come from the
dynamic linker, not our code. Verify against the source before asserting
what produced a given line.

### 9.2 `/proc` Monitoring

**What it is:** `/proc` is a virtual filesystem the kernel exposes at
runtime — reading `/proc/<PID>/status` doesn't read a file from disk, it
asks the kernel to describe a live process on demand.

```bash
./server async &
cat /proc/$!/status
```

Relevant fields (real output from this server):
```
State:    S (sleeping)
Threads:  6          # main + 4 workers + 1 responder
VmSize:   305824 kB  # total virtual memory mapped
VmRSS:      1748 kB  # actual physical memory in use
```
`Threads: 6` is a direct, independently-verifiable confirmation of the
worker-pool design — no source-code trust required.

A small monitoring script is included:
```bash
./monitor_server.sh           # continuous, refreshes every 2s, Ctrl+C to stop
./monitor_server.sh --once    # single snapshot
```
It finds the server by scanning `/proc/[0-9]*/cmdline` (no dependency on
`pgrep`/`ps` behaving a particular way) and prints `State`, `Threads`,
`VmRSS`, `VmSize`, context-switch counts, and open file descriptor count.
If no server is running, it says so plainly instead of crashing.

### 9.3 Debugging with GDB

```bash
make debug          # builds server_debug with -g (line-number info)
gdb ./server_debug
```

A representative session:
```
(gdb) break main
(gdb) run async
(gdb) break handle_client
(gdb) continue        # after a client connects, hits inside handle_client
(gdb) info threads
(gdb) thread apply all bt
```

Real captured output from exactly this sequence:
```
Breakpoint 2, handle_client (client_fd=4) at server.c:523
523     void handle_client(int client_fd) {

  Id   Target Id                          Frame
  1    Thread ... "server_debug"          0x... in accept () from libc.so.6
* 2    Thread ... "server_debug"          handle_client (client_fd=4) at server.c:523
  3    Thread ... "server_debug"          0x... in ?? () from libc.so.6
  ...

Thread 6 (responder):
#0  0x... in ?? () from libc.so.6
#1  0x... in pthread_cond_wait () from libc.so.6
#2  0x... in completion_dequeue () at server.c:404
#3  0x... in responder_thread (arg=0x0) at server.c:463

Thread 5/4/3 (idle workers):
#0  0x... in ?? () from libc.so.6
#1  0x... in pthread_cond_wait () from libc.so.6
#2  0x... in dequeue () at server.c:362
#3  0x... in worker_thread (arg=...) at server.c:1048

Thread 1 (main):
#0  0x... in accept () from libc.so.6
#1  0x... in main (argc=2, argv=...) at server.c:1129
```
This is a genuinely useful multithreaded-debugging demo: you can *see*, not
just claim, that the main thread sits in `accept()`, idle workers sit in
`pthread_cond_wait` inside `dequeue()`, the responder sits in
`pthread_cond_wait` inside `completion_dequeue()`, and exactly one worker is
active inside `handle_client()` while serving a request.

---

## 10. Stage 13 — Optional Dashboard

`gui/dashboard.sh` is a plain-bash terminal dashboard. It does **not**
perform file I/O or duplicate server logic — it only sends the existing
`STATS` command over the existing TCP protocol and formats the reply. No web
server, no new client library, no framework.

```bash
./server async &
./gui/dashboard.sh              # refreshes every second, Ctrl+C to stop
./gui/dashboard.sh --once       # single snapshot
```

```
┌─────────────────────────────────────────┐
│   ASYNCHRONOUS FILE PROCESSING SERVER    │
├─────────────────────────────────────────┤
│ Status            : RUNNING              │
│ Mode              : ASYNC                │
│ Workers           : 4                    │
│ Pending Requests  : 0                    │
│ Completed         : 1                    │
│ Failed            : 0                    │
│                                          │
│ Avg Latency       : 0.238 ms             │
│ Max Latency       : 0.238 ms             │
│ Throughput        : 4197.906 req/s       │
│ Workload Duration : 0.000 sec            │
└─────────────────────────────────────────┘
```
If the server isn't running, it prints `Status: NOT RUNNING` instead of
guessing or hanging.

---

## 11. Viva Questions and Answers

**What is asynchronous I/O?**
A model where a process submits an I/O request to the kernel and continues
running immediately; the kernel performs the actual data transfer in the
background and notifies the process on completion.

**What is synchronous I/O?**
A model where the calling code blocks — makes no progress — until the I/O
operation completes and control returns.

**Why use a request queue?**
It decouples "accepting a new client" from "processing that client," so the
accept loop is never blocked by whatever a worker is doing, and lets a
bounded number of workers serve an unbounded number of arriving clients.

**Why use a completion queue?**
It decouples "an async I/O operation finished" from "sending the response,"
matching the target architecture and giving the responder thread a single,
well-defined point to handle every completion (and, in this project, to
record timing) rather than scattering that logic across every AIO callback.

**Why do we need a mutex?**
To make read-modify-write sequences on shared data (a linked-list queue,
global counters) atomic with respect to other threads — without it, two
threads updating the same pointers or counters simultaneously can corrupt
the data structure or lose updates.

**Why do we need a condition variable?**
So a thread waiting for work (an empty queue) can sleep instead of
busy-waiting in a loop, and be woken immediately when work arrives —
`pthread_cond_wait` atomically unlocks the mutex and sleeps, then re-locks
it on wake.

**Why use a fixed worker pool?**
It caps concurrency and memory/thread overhead at a known, controlled
number regardless of client load, instead of spawning one thread per
client (Stage 4's approach) which is unbounded and unrealistic at scale.

**Why use `clock_gettime(CLOCK_MONOTONIC)`?**
It's immune to system clock adjustments (NTP sync, manual date changes),
which is essential for measuring *durations* — `CLOCK_REALTIME` or `time()`
can jump backward or forward and produce nonsensical or even negative
latency values.

**How is throughput calculated?**
`completed_workload_requests / workload_duration`, where
`workload_duration` is the time from the first workload request's arrival
to the most recent workload completion — never server idle time or total
uptime, and `STATS`/`RESET` requests never count toward it.

**How is latency calculated?**
Per request: `completion_time - arrival_time`, where `arrival_time` is
captured right after `recv()` and `completion_time` is captured right
after the response is actually sent to the client — the fairest definition
of "when the client's request was truly finished."

**Why might sync outperform async for tiny files?**
Because POSIX AIO has real fixed overhead — glibc's `SIGEV_THREAD`
notification spawns a callback thread per completion — and on files small
enough to be served instantly from the page cache, that overhead can exceed
the cost of just doing the blocking call directly. Async's benefit depends
on the I/O being slow enough, or the concurrency high enough, to be worth
overlapping.

**What makes this an Operating Systems project?**
It's built entirely on OS-level interfaces — sockets, file descriptors,
POSIX threads, mutexes, condition variables, asynchronous I/O, and process
introspection via `/proc` — and its central question (blocking vs.
non-blocking I/O under concurrency) is a core OS topic.

**What is the project's contribution?**
Not asynchronous I/O itself, but an integrated, understandable
implementation of concurrent clients + synchronized queues + async I/O +
instrumentation, plus a controlled experimental comparison against a
synchronous baseline using the identical workload and codebase.

**Why don't we modify the Linux kernel?**
The assignment scope is a user-space application; POSIX APIs
(`aio_read`/`aio_write`, pthreads, sockets) give genuine asynchronous and
concurrent behavior without needing kernel-level changes, which would be
out of scope, riskier, and unnecessary for the problem being solved.

**What does `strace` show?**
Every system call a process (and, with `-f`, its threads) makes, in the
order made, with arguments and return values — the literal boundary
between our code and the kernel.

**What is `/proc`?**
A virtual, in-memory filesystem the kernel generates on demand to expose
live information about processes and the system — reading it doesn't touch
disk, it queries running kernel state.

**What does GDB do?**
Attaches to or launches a program under a debugger, letting you set
breakpoints, step through code, inspect variables, and — for a
multithreaded program — see exactly which line every thread is stopped at.

---

## 12. Final Project Structure

```
Asynchronous-File-Processing-Server/
├── server.c
├── client.c
├── bench_lib.sh              # shared bash functions for all benchmark scripts
├── benchmark.sh               # single-run WRITE+READ workload + STATS capture
├── run_experiment.sh          # repeated runs across 3 workloads -> CSV
├── benchmark_filesize.sh      # BENCHWRITE/BENCHREAD file-size testing -> CSV
├── analyze_results.sh         # mean/median summary table from CSVs
├── compare_stats.sh           # one-off SYNC vs ASYNC table from two STATS captures
├── monitor_server.sh          # /proc-based live process monitor
├── Makefile
├── README.md
├── gui/
│   └── dashboard.sh           # optional terminal dashboard (Stage 13)
├── results/                   # created by the benchmark scripts (CSV output)
└── test_files/                # created by the benchmark scripts (workload files)
```
No `performance.c`/`performance.h` split was introduced: the timing/stats
code is a few cleanly-separated functions already, and splitting them into
a separate translation unit would add build complexity (a header, a second
object file, Makefile changes) without making anything easier to explain in
a viva — "only create modules that are actually needed."

---

## 13. Final Demonstration Sequence (5–10 minutes)

1. **Start the async server** — `./server async` — point out the startup
   banner (mode, worker pool size).
2. **Multiple concurrent clients** — open 2–3 terminals, fire concurrent
   `WRITE`/`READ` requests, show they don't block each other.
3. **Request queue in action** — fire more requests than workers (e.g. a
   quick loop of 8 concurrent requests against 4 workers) and point at the
   `[Producer] Enqueued ...` log lines.
4. **Async I/O completing out of band** — point at the log sequence:
   `Submitting ASYNC WRITE` → `worker now free for next request` (worker
   log) → `AIO-Callback ... completed` → `Pushed onto completion queue` →
   `Responder ... Response sent` (three different thread IDs across four
   log lines — visible proof of the submit/complete split).
5. **Live stats** — send `STATS`, then `RESET`, then `STATS` again to show
   it cleanly zeroes.
6. **Sync vs async** — run `./run_experiment.sh sync 3` then
   `./run_experiment.sh async 3`, then `./analyze_results.sh
   results/sync_results.csv results/async_results.csv` — show the real
   summary table.
7. **Linux tools** — `strace -f ./server async` for a few seconds while a
   client connects; `cat /proc/<PID>/status` or `./monitor_server.sh
   --once` to show thread count; optionally `gdb ./server_debug` with
   `break handle_client` + `info threads`.
8. **Dashboard (optional)** — `./gui/dashboard.sh` for a live visual
   summary, only after the above all worked.

---

## 14. Final Testing Checklist

- [x] READ works (sync and async)
- [x] WRITE works (sync and async)
- [x] Multiple concurrent clients handled correctly
- [x] Request queue verified via concurrent-load logs
- [x] Mutex/condvar correctness — no observed corruption across repeated runs
- [x] Async I/O is genuine `aio_read`/`aio_write`, confirmed via `strace`
      (`clone3` for `SIGEV_THREAD`, no direct blocking `read`/`write` in the
      async code path)
- [x] Completion queue verified via responder logs and queue-depth prints
- [x] Responder thread confirmed via `gdb` backtrace
- [x] Async-path early failures (open()/aio_submit() failing before the AIO
      callback ever runs) are correctly counted as Failed, not left as
      permanently-pending phantom entries — found via smoke testing and
      fixed by calling `stats_record_completion()` on every early-return
      error path, not just inside `completion_handler()`
- [x] `STATS` excludes `STATS`/`RESET` requests themselves (checked before
      `stats_record_arrival()` is ever called)
- [x] Throughput uses the actual workload window (`measurement_start`/`end`),
      not server uptime
- [x] Sync and async use the identical workload generator (`fire_workload`)
- [x] Benchmark scripts send requests only via `nc`/the real client protocol
      — never construct or `eval` shell commands from request content
- [x] No hard-coded benchmark results — every number in this README's §6
      came from an actual captured run
- [x] No known memory leaks/double-frees — `big_buf` freed exactly once per
      request in both the sync path and the responder; verified no crashes
      across repeated BENCHWRITE/BENCHREAD/READ/WRITE cycles
- [x] No known race conditions — all shared state (both queues, stats,
      request-ID counter) guarded by its own dedicated mutex
- [x] Malformed/empty/oversized requests handled without crashing (tested:
      empty line, unknown command, missing filename, BENCHWRITE over the
      16 MB cap)
- [x] Documentation (this file) matches the actual implementation
- [x] Compiles cleanly with `-Wall -Wextra`, zero warnings, on Ubuntu/gcc
- [x] Remains a user-space Linux/C application throughout
- [x] No unrelated technologies added — dashboard is plain bash + the
      existing protocol, nothing else

---

## 15. Known Limitations (stated plainly, not hidden)

- `BENCHREAD`/`BENCHWRITE` use a single `read()`/`write()`/`aio_read()`/
  `aio_write()` call rather than a retry loop; this matches the simplicity
  of the rest of the codebase and is fine for regular local files up to the
  16 MB cap, but is not a general-purpose robust I/O routine.
- The request-count workloads in `run_experiment.sh` fire each phase
  (`WRITE`s, then `READ`s) fully concurrently via background `nc` processes;
  on a very resource-constrained machine, firing 250 simultaneous
  connections may be slower than expected — this reflects your machine's
  process-creation and connection-handling capacity, not a server bug.
- The dashboard polls once per second and has no historical graphing —
  it is a demonstration aid, not a monitoring product.
