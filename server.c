#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <pthread.h>
#include <aio.h>
#include <signal.h>
#include <errno.h>
#include <time.h>
#include <sys/stat.h>   // NEW: fstat()/struct stat, used by BENCHREAD to size its buffer

#define PORT 8080
#define BUFFER_SIZE 1024
#define NUM_WORKER_THREADS 4
#define MAX_BENCH_SIZE (16L * 1024 * 1024)  // 16 MB safety cap for BENCHWRITE/BENCHREAD

// ---------------------------------------------------------
// Request format used by this server:
//
//   READ  <filename>
//   WRITE <filename> <data...>
//   STATS                              (query performance stats -- NOT part of the workload)
//   RESET                              (clear performance stats -- NOT part of the workload)
//   BENCHWRITE <filename> <size_bytes> (write <size_bytes> of server-generated filler data --
//                                        used ONLY for controlled file-size benchmarking, see
//                                        Stage 10.3. Counts as a WRITE in the stats.)
//   BENCHREAD  <filename>              (read the entire file but reply with only a byte count,
//                                        not the file content -- avoids needing a huge network
//                                        buffer just to benchmark disk read time. Counts as a
//                                        READ in the stats.)
// ---------------------------------------------------------

// ===========================================================
// SERVER MODE (NEW in Stage 9)
//
// Selected once at startup from argv[1] ("sync" or "async") and
// never changed afterward. Both modes use the EXACT SAME:
//   - TCP accept loop
//   - thread-safe request queue (enqueue/dequeue, mutex+condvar)
//   - fixed-size worker pool
//   - completion queue + responder thread (they simply stay idle
//     in sync mode, since nothing is ever pushed onto them)
//   - stats_record_arrival() / stats_record_completion() / STATS
//
// Only the BODY of request processing differs -- see the two
// branches inside handle_client() below.
// ===========================================================
typedef enum {
    MODE_ASYNC,
    MODE_SYNC
} ServerMode;

ServerMode server_mode = MODE_ASYNC;  // default if no argument given

const char *mode_name(ServerMode m) {
    return (m == MODE_SYNC) ? "SYNC" : "ASYNC";
}

// -------------------------------------------------
// BENCHREAD/BENCHWRITE (Stage 10.3) perform the same underlying
// syscall direction as READ/WRITE, just with a heap-allocated
// buffer and a lighter response. These helpers let the rest of
// the code ask "is this a read-direction op?" / "write-direction?"
// without hardcoding four separate strcmp chains everywhere.
// -------------------------------------------------
int is_read_op(const char *op) {
    return strcmp(op, "READ") == 0 || strcmp(op, "BENCHREAD") == 0;
}

int is_write_op(const char *op) {
    return strcmp(op, "WRITE") == 0 || strcmp(op, "BENCHWRITE") == 0;
}

// Maps an operation name to the bucket ("READ" or "WRITE") that
// stats_record_completion() should count it under, so BENCHREAD
// still increments read_count and BENCHWRITE still increments
// write_count -- the STATS output format stays exactly as
// specified in Stage 8 (no new READ/WRITE-like counters needed).
const char *count_bucket(const char *op) {
    return is_read_op(op) ? "READ" : "WRITE";
}

// ===========================================================
// TIME HELPER
//
// CLOCK_MONOTONIC only ever moves forward at a steady rate --
// immune to system clock adjustments (NTP sync, manual date
// changes). Correct choice for measuring DURATIONS (latency,
// workload duration) rather than wall-clock date/time.
// ===========================================================
double get_time_seconds() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

// ===========================================================
// GLOBAL PERFORMANCE STATISTICS
//
// CORRECTED in this revision:
//   - measurement_start / measurement_end now bound the actual
//     WORKLOAD window (first real request -> last completion),
//     NOT server uptime.
//   - STATS requests never touch any of these fields.
//   - min_latency and per-operation (READ/WRITE) counts added.
//
// Shared across ALL threads:
//   - workers call stats_record_arrival() when a workload
//     request arrives (never for STATS).
//   - the responder calls stats_record_completion() when a
//     workload request finishes.
// Protected by its own dedicated mutex.
// ===========================================================
typedef struct {
    long total_requests;
    long completed_requests;
    long failed_requests;

    long read_count;
    long write_count;

    double total_latency;     // sum of all latencies, for computing the average
    double min_latency;       // -1 means "not yet set"
    double max_latency;

    int measurement_started;   // becomes 1 on the FIRST non-STATS request
    double measurement_start;  // arrival time of that first workload request
    double measurement_end;    // completion time of the MOST RECENT workload request
} ServerStats;

ServerStats stats = {0, 0, 0, 0, 0, 0.0, -1.0, 0.0, 0, 0.0, 0.0};
pthread_mutex_t stats_mutex = PTHREAD_MUTEX_INITIALIZER;

// Called by a worker when a new WORKLOAD request arrives (never for STATS).
// Also marks the start of the measurement window on the very first call.
void stats_record_arrival(double arrival_time) {
    pthread_mutex_lock(&stats_mutex);

    stats.total_requests++;

    if (!stats.measurement_started) {
        stats.measurement_started = 1;
        stats.measurement_start = arrival_time;
    }

    pthread_mutex_unlock(&stats_mutex);
}

// Called by the responder when a WORKLOAD request finishes (success or failure).
// Updates the end of the measurement window to this completion's timestamp.
void stats_record_completion(const char *operation, int success,
                              double latency, double completion_time) {
    pthread_mutex_lock(&stats_mutex);

    if (success) {
        stats.completed_requests++;
    } else {
        stats.failed_requests++;
    }

    if (strcmp(operation, "READ") == 0) {
        stats.read_count++;
    } else if (strcmp(operation, "WRITE") == 0) {
        stats.write_count++;
    }

    stats.total_latency += latency;

    if (stats.min_latency < 0 || latency < stats.min_latency) {
        stats.min_latency = latency;
    }
    if (latency > stats.max_latency) {
        stats.max_latency = latency;
    }

    // The measurement window always extends to the latest completion.
    stats.measurement_end = completion_time;

    pthread_mutex_unlock(&stats_mutex);
}

// Resets all workload statistics back to their initial state.
// Used by the NEW 'RESET' command so repeated benchmark runs can
// each start from a clean slate WITHOUT restarting the server
// process (faster, and avoids re-creating the worker pool each time).
void stats_reset() {
    pthread_mutex_lock(&stats_mutex);

    stats.total_requests = 0;
    stats.completed_requests = 0;
    stats.failed_requests = 0;
    stats.read_count = 0;
    stats.write_count = 0;
    stats.total_latency = 0.0;
    stats.min_latency = -1.0;
    stats.max_latency = 0.0;
    stats.measurement_started = 0;
    stats.measurement_start = 0.0;
    stats.measurement_end = 0.0;

    pthread_mutex_unlock(&stats_mutex);
}

// Builds a human-readable snapshot of current stats into `out`.
void stats_snapshot(char *out, size_t out_size) {
    pthread_mutex_lock(&stats_mutex);

    long total = stats.total_requests;
    long completed = stats.completed_requests;
    long failed = stats.failed_requests;
    long read_count = stats.read_count;
    long write_count = stats.write_count;

    double total_latency = stats.total_latency;
    double min_latency = (stats.min_latency < 0) ? 0.0 : stats.min_latency;
    double max_latency = stats.max_latency;

    double measurement_start = stats.measurement_start;
    double measurement_end = stats.measurement_end;
    int measurement_started = stats.measurement_started;

    pthread_mutex_unlock(&stats_mutex);

    long finished = completed + failed;
    double avg_latency = (finished > 0) ? (total_latency / finished) : 0.0;
    long pending = total - finished;  // requests submitted but not yet completed/failed

    // -------------------------------------------------
    // Fix 1 / Fix 3: workload duration is measured from the
    // FIRST workload request's arrival to the LAST workload
    // request's completion -- never server uptime, and never
    // including idle time before/after the workload.
    // -------------------------------------------------
    double workload_duration = 0.0;
    double throughput = 0.0;

    if (measurement_started && completed > 0) {
        workload_duration = measurement_end - measurement_start;
        if (workload_duration > 0) {
            throughput = completed / workload_duration;
        }
        // else: workload_duration <= 0 (e.g. a single, instantaneous
        // completion) -- leave throughput at 0 rather than dividing
        // by zero or reporting a meaningless huge number.
    }
    // else: no completed workload requests yet -- throughput stays 0.

    // NOTE: "Mode", "Worker threads" and "Pending requests" are extra
    // fields added for the Stage 13 dashboard. They are appended
    // WITHOUT removing or renaming any of the Stage 8 fields, so
    // compare_stats.sh / analyze_results.sh (which grep for the
    // original field labels) keep working unmodified.
    snprintf(out, out_size,
        "---- SERVER STATS ----\n"
        "Mode                     : %s\n"
        "Worker threads           : %d\n"
        "Pending requests         : %ld\n"
        "\n"
        "Total workload requests : %ld\n"
        "Completed successfully  : %ld\n"
        "Failed                  : %ld\n"
        "\n"
        "READ requests           : %ld\n"
        "WRITE requests          : %ld\n"
        "\n"
        "Average latency (ms)    : %.3f\n"
        "Minimum latency (ms)    : %.3f\n"
        "Maximum latency (ms)    : %.3f\n"
        "\n"
        "Workload duration (sec) : %.3f\n"
        "Throughput (req/sec)    : %.3f\n"
        "------------------------\n",
        mode_name(server_mode), NUM_WORKER_THREADS, pending,
        total, completed, failed,
        read_count, write_count,
        avg_latency * 1000.0, min_latency * 1000.0, max_latency * 1000.0,
        workload_duration, throughput);
}

// ===========================================================
// ASYNC REQUEST CONTEXT
// ===========================================================

typedef struct AsyncRequest {
    struct aiocb cb;
    int client_fd;
    int file_fd;
    char operation[16];
    char filename[100];
    char buffer[BUFFER_SIZE];

    // Used ONLY by BENCHWRITE/BENCHREAD (Stage 10.3 large-file testing).
    // Normal READ/WRITE keep using the small fixed 'buffer' above --
    // this heap-allocated buffer exists so we can test file sizes
    // (100 KB, 1 MB, ...) far larger than BUFFER_SIZE WITHOUT changing
    // the control-protocol's line-based buffer at all. NULL when unused.
    void *big_buf;
    size_t big_buf_size;

    long request_id;
    double arrival_time;
    double start_time;
    double completion_time;

    int success;
    ssize_t bytes_result;
    int error_code;

    struct AsyncRequest *next;
} AsyncRequest;

long next_request_id = 1;
pthread_mutex_t id_mutex = PTHREAD_MUTEX_INITIALIZER;

long get_next_request_id() {
    pthread_mutex_lock(&id_mutex);
    long id = next_request_id++;
    pthread_mutex_unlock(&id_mutex);
    return id;
}

// ===========================================================
// REQUEST QUEUE (unchanged from Stage 5/7)
// ===========================================================

typedef struct QueueNode {
    int client_fd;
    struct QueueNode *next;
} QueueNode;

QueueNode *queue_head = NULL;
QueueNode *queue_tail = NULL;
int queue_size = 0;

pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t queue_cond = PTHREAD_COND_INITIALIZER;

void enqueue(int client_fd) {
    QueueNode *node = malloc(sizeof(QueueNode));
    node->client_fd = client_fd;
    node->next = NULL;

    pthread_mutex_lock(&queue_mutex);
    if (queue_tail == NULL) {
        queue_head = node;
        queue_tail = node;
    } else {
        queue_tail->next = node;
        queue_tail = node;
    }
    queue_size++;
    pthread_cond_signal(&queue_cond);
    pthread_mutex_unlock(&queue_mutex);
}

int dequeue() {
    pthread_mutex_lock(&queue_mutex);
    while (queue_size == 0) {
        pthread_cond_wait(&queue_cond, &queue_mutex);
    }
    QueueNode *node = queue_head;
    int client_fd = node->client_fd;
    queue_head = queue_head->next;
    if (queue_head == NULL) queue_tail = NULL;
    queue_size--;
    pthread_mutex_unlock(&queue_mutex);
    free(node);
    return client_fd;
}

// ===========================================================
// COMPLETION QUEUE (unchanged from Stage 7)
// ===========================================================

AsyncRequest *completion_head = NULL;
AsyncRequest *completion_tail = NULL;
int completion_size = 0;

pthread_mutex_t completion_mutex = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t completion_cond = PTHREAD_COND_INITIALIZER;

void completion_enqueue(AsyncRequest *req) {
    req->next = NULL;

    pthread_mutex_lock(&completion_mutex);
    if (completion_tail == NULL) {
        completion_head = req;
        completion_tail = req;
    } else {
        completion_tail->next = req;
        completion_tail = req;
    }
    completion_size++;
    pthread_cond_signal(&completion_cond);
    pthread_mutex_unlock(&completion_mutex);
}

AsyncRequest *completion_dequeue() {
    pthread_mutex_lock(&completion_mutex);
    while (completion_size == 0) {
        pthread_cond_wait(&completion_cond, &completion_mutex);
    }
    AsyncRequest *req = completion_head;
    completion_head = completion_head->next;
    if (completion_head == NULL) completion_tail = NULL;
    completion_size--;
    pthread_mutex_unlock(&completion_mutex);
    return req;
}

// ===========================================================
// COMPLETION CALLBACK (unchanged)
// ===========================================================
void completion_handler(union sigval sv) {
    AsyncRequest *req = (AsyncRequest *)sv.sival_ptr;

    int err = aio_error(&req->cb);

    if (err == 0) {
        ssize_t result = aio_return(&req->cb);
        req->success = 1;
        req->bytes_result = result;

        // Only plain READ echoes content back to the client, so only
        // it needs a null terminator in its small fixed buffer.
        // BENCHREAD deliberately does NOT send file content back (see
        // responder_thread), and BENCHWRITE/BENCHREAD use big_buf, not
        // this fixed buffer, so neither needs this at all.
        if (strcmp(req->operation, "READ") == 0) {
            req->buffer[result] = '\0';
        }

        printf("[AIO-Callback tid %lu] req #%ld: %s completed for %s (%zd bytes)\n",
               (unsigned long)pthread_self(), req->request_id, req->operation, req->filename, result);
    }
    else {
        req->success = 0;
        req->error_code = err;
        printf("[AIO-Callback tid %lu] req #%ld: %s FAILED for %s: %s\n",
               (unsigned long)pthread_self(), req->request_id, req->operation, req->filename, strerror(err));
    }

    close(req->file_fd);
    completion_enqueue(req);
}

// ===========================================================
// RESPONDER THREAD
//
// CHANGED in this revision: passes operation + completion_time
// into stats_record_completion() so read/write counts and the
// workload measurement window get updated correctly.
// ===========================================================
void *responder_thread(void *arg) {
    (void)arg;
    printf("[Responder, tid %lu] started, waiting for completed requests...\n",
           (unsigned long)pthread_self());

    while (1) {
        AsyncRequest *req = completion_dequeue();

        if (req->success) {
            if (strcmp(req->operation, "READ") == 0) {
                // Plain READ: echo the actual file content back.
                send(req->client_fd, req->buffer, req->bytes_result, 0);
            }
            else if (strcmp(req->operation, "BENCHREAD") == 0) {
                // BENCHREAD: deliberately does NOT send file content --
                // only a byte count. This keeps the control protocol's
                // small buffer untouched even when testing multi-MB
                // files (see the top-of-file protocol comment).
                char success[BUFFER_SIZE];
                snprintf(success, BUFFER_SIZE,
                         "SUCCESS: Read %zd bytes from %s", req->bytes_result, req->filename);
                send(req->client_fd, success, strlen(success), 0);
            }
            else {
                // WRITE or BENCHWRITE
                char success[BUFFER_SIZE];
                snprintf(success, BUFFER_SIZE,
                         "SUCCESS: Wrote %zd bytes to %s", req->bytes_result, req->filename);
                send(req->client_fd, success, strlen(success), 0);
            }
        }
        else {
            char error[] = "ERROR: Asynchronous file operation failed.";
            send(req->client_fd, error, strlen(error), 0);
        }

        // completion_time = the moment the client actually receives
        // their response (after send()) -- the fairest definition
        // of "when the request truly finished."
        req->completion_time = get_time_seconds();
        double latency = req->completion_time - req->arrival_time;

        stats_record_completion(count_bucket(req->operation), req->success, latency, req->completion_time);

        printf("[Responder tid %lu] req #%ld: %s %s -> %s | latency=%.3f ms\n\n",
               (unsigned long)pthread_self(), req->request_id, req->operation, req->filename,
               req->success ? "OK" : "FAILED", latency * 1000.0);

        close(req->client_fd);
        if (req->big_buf != NULL) {
            free(req->big_buf);
        }
        free(req);
    }

    return NULL;
}

// ===========================================================
// WORKER-SIDE REQUEST HANDLING
//
// CHANGED in this revision: STATS is handled and returns BEFORE
// stats_record_arrival() is ever called, so it can never start
// the measurement window or count toward total_requests. This
// satisfies Fix 2 directly.
// ===========================================================
void handle_client(int client_fd) {
    char request[BUFFER_SIZE];

    memset(request, 0, BUFFER_SIZE);

    int bytes_received = recv(client_fd, request, BUFFER_SIZE - 1, 0);
    double arrival_time = get_time_seconds();

    if (bytes_received <= 0) {
        printf("[Worker %lu] Failed to receive request.\n",
               (unsigned long)pthread_self());
        close(client_fd);
        return;
    }

    request[bytes_received] = '\0';
    request[strcspn(request, "\n")] = '\0';

    // -------------------------------------------------
    // Parse just the FIRST token (the operation) up front.
    // STATS and RESET are single-word commands; everything
    // else additionally needs a filename (and BENCHWRITE also
    // needs a size). Parsing the operation first lets us dispatch
    // cleanly instead of guessing the token count in advance.
    // -------------------------------------------------
    char operation[16];

    if (sscanf(request, "%15s", operation) != 1) {
        char error[] = "ERROR: Empty request.";
        send(client_fd, error, strlen(error), 0);
        close(client_fd);
        return;
    }

    // -------------------------------------------------
    // STATS command: answered directly. Deliberately placed
    // BEFORE stats_record_arrival() so it never touches the
    // workload counters or the measurement window (Fix 2).
    // -------------------------------------------------
    if (strcmp(operation, "STATS") == 0) {
        char snapshot[768];
        stats_snapshot(snapshot, sizeof(snapshot));
        send(client_fd, snapshot, strlen(snapshot), 0);
        close(client_fd);
        printf("[Worker %lu] Handled STATS request (not counted in workload stats).\n\n",
               (unsigned long)pthread_self());
        return;
    }

    // -------------------------------------------------
    // RESET command (NEW in Stage 10): clears all workload
    // statistics so a fresh benchmark run can start from zero
    // without restarting the server process. Also never counted
    // as a workload request, for the same reason as STATS.
    // -------------------------------------------------
    if (strcmp(operation, "RESET") == 0) {
        stats_reset();
        char msg[] = "SUCCESS: Stats reset.";
        send(client_fd, msg, strlen(msg), 0);
        close(client_fd);
        printf("[Worker %lu] Handled RESET request (workload stats cleared).\n\n",
               (unsigned long)pthread_self());
        return;
    }

    printf("[Worker %lu] Request received: %s\n", (unsigned long)pthread_self(), request);

    char filename[100];
    long bench_size = 0;   // only used by BENCHWRITE

    if (strcmp(operation, "READ") == 0 || strcmp(operation, "BENCHREAD") == 0) {
        if (sscanf(request, "%*s %99s", filename) != 1) {
            char error[] = "ERROR: Invalid request format. Use: READ FILENAME";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            return;
        }
    }
    else if (strcmp(operation, "WRITE") == 0) {
        if (sscanf(request, "%*s %99s", filename) != 1) {
            char error[] = "ERROR: Invalid request format. Use: WRITE FILENAME DATA...";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            return;
        }
    }
    else if (strcmp(operation, "BENCHWRITE") == 0) {
        // BENCHWRITE FILENAME SIZE_BYTES -- the payload itself is
        // NEVER sent over the network; the server generates it
        // in-memory. This is the "clean benchmark-specific mechanism"
        // for testing large file sizes without enlarging or
        // corrupting the normal line-based control protocol.
        if (sscanf(request, "%*s %99s %ld", filename, &bench_size) != 2 || bench_size <= 0) {
            char error[] = "ERROR: Invalid request format. Use: BENCHWRITE FILENAME SIZE_BYTES";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            return;
        }
        if (bench_size > MAX_BENCH_SIZE) {
            char error[] = "ERROR: Requested BENCHWRITE size exceeds server-side safety cap.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            return;
        }
    }
    else {
        char error[] = "ERROR: Unsupported operation. Use READ, WRITE, BENCHREAD, BENCHWRITE, STATS, or RESET.";
        send(client_fd, error, strlen(error), 0);
        close(client_fd);
        return;
    }

    // This is a real workload request -- count it and (if it's the
    // first one this run) start the measurement window.
    stats_record_arrival(arrival_time);

    // -------------------------------------------------
    // SYNCHRONOUS PATH (Stage 9)
    //
    // Deliberately uses plain blocking open()/read()/write()/close()
    // -- no aio_read/aio_write, no completion queue, no responder
    // thread involvement. The worker thread that dequeued this
    // client is BUSY for the entire duration of the file operation
    // and only becomes available for the next queued client after
    // it has sent this client's response and returned from this
    // function.
    // -------------------------------------------------
    if (server_mode == MODE_SYNC) {
        long request_id = get_next_request_id();
        int op_success = 0;
        ssize_t bytes_result = 0;

        if (strcmp(operation, "READ") == 0) {

            printf("[Worker %lu] req #%ld (SYNC): blocking READ for %s\n",
                   (unsigned long)pthread_self(), request_id, filename);

            char resp_buffer[BUFFER_SIZE];
            int fd = open(filename, O_RDONLY);
            if (fd < 0) {
                perror("open");
                char error[] = "ERROR: Could not open file.";
                send(client_fd, error, strlen(error), 0);
            }
            else {
                ssize_t n = read(fd, resp_buffer, BUFFER_SIZE - 1);
                close(fd);

                if (n < 0) {
                    perror("read");
                    char error[] = "ERROR: Could not read file.";
                    send(client_fd, error, strlen(error), 0);
                }
                else {
                    resp_buffer[n] = '\0';
                    send(client_fd, resp_buffer, n, 0);
                    op_success = 1;
                    bytes_result = n;
                }
            }
        }
        else if (strcmp(operation, "WRITE") == 0) {
            printf("[Worker %lu] req #%ld (SYNC): blocking WRITE for %s\n",
                   (unsigned long)pthread_self(), request_id, filename);

            char *data_ptr = strstr(request, filename);
            char *file_content = "";
            if (data_ptr != NULL) {
                data_ptr += strlen(filename);
                if (*data_ptr == ' ') data_ptr++;
                file_content = data_ptr;
            }

            int fd = open(filename, O_WRONLY | O_CREAT | O_TRUNC, 0644);
            if (fd < 0) {
                perror("open");
                char error[] = "ERROR: Could not open/create file for writing.";
                send(client_fd, error, strlen(error), 0);
            }
            else {
                size_t content_len = strlen(file_content);
                ssize_t n = write(fd, file_content, content_len);
                close(fd);

                if (n < 0) {
                    perror("write");
                    char error[] = "ERROR: Could not write to file.";
                    send(client_fd, error, strlen(error), 0);
                }
                else {
                    char success[BUFFER_SIZE];
                    snprintf(success, BUFFER_SIZE,
                             "SUCCESS: Wrote %zd bytes to %s", n, filename);
                    send(client_fd, success, strlen(success), 0);
                    op_success = 1;
                    bytes_result = n;
                }
            }
        }
        else if (strcmp(operation, "BENCHWRITE") == 0) {
            printf("[Worker %lu] req #%ld (SYNC): blocking BENCHWRITE for %s (%ld bytes)\n",
                   (unsigned long)pthread_self(), request_id, filename, bench_size);

            char *big_buf = malloc(bench_size);
            if (big_buf == NULL) {
                char error[] = "ERROR: Server out of memory for BENCHWRITE.";
                send(client_fd, error, strlen(error), 0);
            }
            else {
                memset(big_buf, 'X', bench_size);  // content doesn't matter, only size

                int fd = open(filename, O_WRONLY | O_CREAT | O_TRUNC, 0644);
                if (fd < 0) {
                    perror("open");
                    char error[] = "ERROR: Could not open/create file for writing.";
                    send(client_fd, error, strlen(error), 0);
                }
                else {
                    ssize_t n = write(fd, big_buf, bench_size);
                    close(fd);

                    if (n < 0) {
                        perror("write");
                        char error[] = "ERROR: Could not write to file.";
                        send(client_fd, error, strlen(error), 0);
                    }
                    else {
                        char success[BUFFER_SIZE];
                        snprintf(success, BUFFER_SIZE,
                                 "SUCCESS: Wrote %zd bytes to %s", n, filename);
                        send(client_fd, success, strlen(success), 0);
                        op_success = 1;
                        bytes_result = n;
                    }
                }
                free(big_buf);
            }
        }
        else { // BENCHREAD
            printf("[Worker %lu] req #%ld (SYNC): blocking BENCHREAD for %s\n",
                   (unsigned long)pthread_self(), request_id, filename);

            int fd = open(filename, O_RDONLY);
            if (fd < 0) {
                perror("open");
                char error[] = "ERROR: Could not open file.";
                send(client_fd, error, strlen(error), 0);
            }
            else {
                struct stat st;
                if (fstat(fd, &st) < 0 || st.st_size <= 0 || st.st_size > MAX_BENCH_SIZE) {
                    close(fd);
                    char error[] = "ERROR: Could not stat file for BENCHREAD.";
                    send(client_fd, error, strlen(error), 0);
                }
                else {
                    char *big_buf = malloc(st.st_size);
                    if (big_buf == NULL) {
                        close(fd);
                        char error[] = "ERROR: Server out of memory for BENCHREAD.";
                        send(client_fd, error, strlen(error), 0);
                    }
                    else {
                        ssize_t n = read(fd, big_buf, st.st_size);
                        close(fd);

                        if (n < 0) {
                            perror("read");
                            char error[] = "ERROR: Could not read file.";
                            send(client_fd, error, strlen(error), 0);
                        }
                        else {
                            // Deliberately do NOT send big_buf's content --
                            // only the byte count, to keep the control
                            // protocol's response buffer small.
                            char success[BUFFER_SIZE];
                            snprintf(success, BUFFER_SIZE,
                                     "SUCCESS: Read %zd bytes from %s", n, filename);
                            send(client_fd, success, strlen(success), 0);
                            op_success = 1;
                            bytes_result = n;
                        }
                        free(big_buf);
                    }
                }
            }
        }

        // Response has been sent -- the request is complete RIGHT NOW,
        // synchronously, before this function returns.
        double completion_time = get_time_seconds();
        double latency = completion_time - arrival_time;

        stats_record_completion(count_bucket(operation), op_success, latency, completion_time);

        printf("[Worker %lu] req #%ld (SYNC): %s %s -> %s | latency=%.3f ms | %zd bytes\n\n",
               (unsigned long)pthread_self(), request_id, operation, filename,
               op_success ? "OK" : "FAILED", latency * 1000.0, bytes_result);

        close(client_fd);
        return;
    }

    // -------------------------------------------------
    // ASYNCHRONOUS PATH (Stage 6/7/8, extended in Stage 10 with
    // BENCHREAD/BENCHWRITE branches that use a heap-allocated
    // big_buf instead of the small fixed 'buffer' field)
    // -------------------------------------------------
    AsyncRequest *req = malloc(sizeof(AsyncRequest));
    memset(req, 0, sizeof(AsyncRequest));

    req->client_fd = client_fd;
    req->request_id = get_next_request_id();
    req->arrival_time = arrival_time;
    strncpy(req->operation, operation, sizeof(req->operation) - 1);
    strncpy(req->filename, filename, sizeof(req->filename) - 1);

    if (strcmp(operation, "READ") == 0) {

        int fd = open(filename, O_RDONLY);
        if (fd < 0) {
            perror("open");
            char error[] = "ERROR: Could not open file.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }
        req->file_fd = fd;

        req->cb.aio_fildes = fd;
        req->cb.aio_buf = req->buffer;
        req->cb.aio_nbytes = BUFFER_SIZE - 1;
        req->cb.aio_offset = 0;

        req->cb.aio_sigevent.sigev_notify = SIGEV_THREAD;
        req->cb.aio_sigevent.sigev_notify_function = completion_handler;
        req->cb.aio_sigevent.sigev_notify_attributes = NULL;
        req->cb.aio_sigevent.sigev_value.sival_ptr = req;

        req->start_time = get_time_seconds();

        printf("[Worker %lu] req #%ld: Submitting ASYNC READ for %s\n",
               (unsigned long)pthread_self(), req->request_id, filename);

        if (aio_read(&req->cb) == -1) {
            perror("aio_read");
            char error[] = "ERROR: Could not submit async read.";
            send(client_fd, error, strlen(error), 0);
            close(fd);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }
    }
    else if (strcmp(operation, "WRITE") == 0) {
        char *data_ptr = strstr(request, filename);
        char *file_content = "";
        if (data_ptr != NULL) {
            data_ptr += strlen(filename);
            if (*data_ptr == ' ') data_ptr++;
            file_content = data_ptr;
        }

        strncpy(req->buffer, file_content, BUFFER_SIZE - 1);
        size_t content_len = strlen(req->buffer);

        int fd = open(filename, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) {
            perror("open");
            char error[] = "ERROR: Could not open/create file for writing.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }
        req->file_fd = fd;

        req->cb.aio_fildes = fd;
        req->cb.aio_buf = req->buffer;
        req->cb.aio_nbytes = content_len;
        req->cb.aio_offset = 0;

        req->cb.aio_sigevent.sigev_notify = SIGEV_THREAD;
        req->cb.aio_sigevent.sigev_notify_function = completion_handler;
        req->cb.aio_sigevent.sigev_notify_attributes = NULL;
        req->cb.aio_sigevent.sigev_value.sival_ptr = req;

        req->start_time = get_time_seconds();

        printf("[Worker %lu] req #%ld: Submitting ASYNC WRITE for %s\n",
               (unsigned long)pthread_self(), req->request_id, filename);

        if (aio_write(&req->cb) == -1) {
            perror("aio_write");
            char error[] = "ERROR: Could not submit async write.";
            send(client_fd, error, strlen(error), 0);
            close(fd);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }
    }
    else if (strcmp(operation, "BENCHWRITE") == 0) {
        req->big_buf = malloc(bench_size);
        if (req->big_buf == NULL) {
            char error[] = "ERROR: Server out of memory for BENCHWRITE.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }
        memset(req->big_buf, 'X', bench_size);
        req->big_buf_size = bench_size;

        int fd = open(filename, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) {
            perror("open");
            char error[] = "ERROR: Could not open/create file for writing.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req->big_buf);
            free(req);
            return;
        }
        req->file_fd = fd;

        req->cb.aio_fildes = fd;
        req->cb.aio_buf = req->big_buf;
        req->cb.aio_nbytes = bench_size;
        req->cb.aio_offset = 0;

        req->cb.aio_sigevent.sigev_notify = SIGEV_THREAD;
        req->cb.aio_sigevent.sigev_notify_function = completion_handler;
        req->cb.aio_sigevent.sigev_notify_attributes = NULL;
        req->cb.aio_sigevent.sigev_value.sival_ptr = req;

        req->start_time = get_time_seconds();

        printf("[Worker %lu] req #%ld: Submitting ASYNC BENCHWRITE for %s (%ld bytes)\n",
               (unsigned long)pthread_self(), req->request_id, filename, bench_size);

        if (aio_write(&req->cb) == -1) {
            perror("aio_write");
            char error[] = "ERROR: Could not submit async benchwrite.";
            send(client_fd, error, strlen(error), 0);
            close(fd);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req->big_buf);
            free(req);
            return;
        }
    }
    else { // BENCHREAD
        int fd = open(filename, O_RDONLY);
        if (fd < 0) {
            perror("open");
            char error[] = "ERROR: Could not open file.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }

        struct stat st;
        if (fstat(fd, &st) < 0 || st.st_size <= 0 || st.st_size > MAX_BENCH_SIZE) {
            close(fd);
            char error[] = "ERROR: Could not stat file for BENCHREAD.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }

        req->big_buf = malloc(st.st_size);
        if (req->big_buf == NULL) {
            close(fd);
            char error[] = "ERROR: Server out of memory for BENCHREAD.";
            send(client_fd, error, strlen(error), 0);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req);
            return;
        }
        req->big_buf_size = st.st_size;
        req->file_fd = fd;

        req->cb.aio_fildes = fd;
        req->cb.aio_buf = req->big_buf;
        req->cb.aio_nbytes = st.st_size;
        req->cb.aio_offset = 0;

        req->cb.aio_sigevent.sigev_notify = SIGEV_THREAD;
        req->cb.aio_sigevent.sigev_notify_function = completion_handler;
        req->cb.aio_sigevent.sigev_notify_attributes = NULL;
        req->cb.aio_sigevent.sigev_value.sival_ptr = req;

        req->start_time = get_time_seconds();

        printf("[Worker %lu] req #%ld: Submitting ASYNC BENCHREAD for %s (%lld bytes)\n",
               (unsigned long)pthread_self(), req->request_id, filename, (long long)st.st_size);

        if (aio_read(&req->cb) == -1) {
            perror("aio_read");
            char error[] = "ERROR: Could not submit async benchread.";
            send(client_fd, error, strlen(error), 0);
            close(fd);
            close(client_fd);
            double t = get_time_seconds();
            stats_record_completion(count_bucket(operation), 0, t - arrival_time, t);
            free(req->big_buf);
            free(req);
            return;
        }
    }

    printf("[Worker %lu] req #%ld: Async op submitted, worker now free for next request.\n\n",
           (unsigned long)pthread_self(), req->request_id);
}

void *worker_thread(void *arg) {
    int worker_id = *(int *)arg;
    free(arg);

    printf("[Worker #%d, tid %lu] started, waiting for requests...\n",
           worker_id, (unsigned long)pthread_self());

    while (1) {
        int client_fd = dequeue();
        handle_client(client_fd);
    }

    return NULL;
}

int main(int argc, char *argv[]) {
    int server_fd, client_fd;
    struct sockaddr_in server_addr;

    // -------------------------------------------------
    // Mode selection (NEW in Stage 9)
    //   ./server sync   -> blocking I/O in the worker
    //   ./server async  -> POSIX AIO (Stage 6-8 behavior)
    //   ./server        -> defaults to async, with a notice
    // -------------------------------------------------
    if (argc >= 2) {
        if (strcmp(argv[1], "sync") == 0) {
            server_mode = MODE_SYNC;
        }
        else if (strcmp(argv[1], "async") == 0) {
            server_mode = MODE_ASYNC;
        }
        else {
            fprintf(stderr, "Usage: %s [sync|async]\n", argv[0]);
            return 1;
        }
    }
    else {
        printf("No mode specified -- defaulting to ASYNC.\n");
        printf("(Use '%s sync' or '%s async' to choose explicitly.)\n\n", argv[0], argv[0]);
    }

    server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return 1;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(PORT);

    if (bind(server_fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        perror("bind");
        close(server_fd);
        return 1;
    }

    if (listen(server_fd, 10) < 0) {
        perror("listen");
        close(server_fd);
        return 1;
    }

    // NOTE: we deliberately do NOT set any stats timestamp here.
    // The measurement window is now defined purely by workload
    // activity (first real request -> last completion), not by
    // when the server process happened to start.

    pthread_t workers[NUM_WORKER_THREADS];
    for (int i = 0; i < NUM_WORKER_THREADS; i++) {
        int *worker_id = malloc(sizeof(int));
        *worker_id = i + 1;
        pthread_create(&workers[i], NULL, worker_thread, worker_id);
    }

    pthread_t responder;
    pthread_create(&responder, NULL, responder_thread, NULL);

    printf("Server started on port %d\n", PORT);
    printf("Mode: %s\n", mode_name(server_mode));
    printf("Worker pool size: %d | Responder threads: 1\n", NUM_WORKER_THREADS);
    printf("Send 'STATS' as a request to view live performance stats.\n");
    printf("Waiting for clients... (Ctrl+C to stop)\n\n");

    while (1) {
        client_fd = accept(server_fd, NULL, NULL);
        if (client_fd < 0) {
            perror("accept");
            continue;
        }

        enqueue(client_fd);
    }

    close(server_fd);
    return 0;
}
