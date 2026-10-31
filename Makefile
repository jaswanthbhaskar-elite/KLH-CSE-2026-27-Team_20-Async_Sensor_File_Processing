# ---------------------------------------------------------
# Makefile -- Asynchronous File Processing Server
#
# Targets:
#   make            -> builds server and client (release, no debug symbols)
#   make debug      -> builds server_debug (with -g, for gdb) and client
#   make clean      -> removes binaries, test_files/, results/, logs
#   make run-sync   -> builds then starts the server in sync mode
#   make run-async  -> builds then starts the server in async mode
# ---------------------------------------------------------

CC = gcc
CFLAGS = -Wall -Wextra
LDFLAGS = -lpthread -lrt

.PHONY: all debug clean run-sync run-async

all: server client

server: server.c
	$(CC) $(CFLAGS) -o server server.c $(LDFLAGS)

client: client.c
	$(CC) $(CFLAGS) -o client client.c

debug: server.c client.c
	$(CC) $(CFLAGS) -g -o server_debug server.c $(LDFLAGS)
	$(CC) $(CFLAGS) -g -o client_debug client.c

run-sync: server
	./server sync

run-async: server
	./server async

clean:
	rm -f server client server_debug client_debug
	rm -rf test_files results
	rm -f server_*.log *.csv
	rm -f gmon.out core
