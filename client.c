#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#define PORT 8080
#define BUFFER_SIZE 1024

int main() {
    int sock;
    struct sockaddr_in server_addr;

    char request[BUFFER_SIZE];
    char response[BUFFER_SIZE];

    sock = socket(AF_INET, SOCK_STREAM, 0);

    if (sock < 0) {
        perror("socket");
        return 1;
    }

    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(PORT);
    server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (connect(sock,
                (struct sockaddr *)&server_addr,
                sizeof(server_addr)) < 0) {
        perror("connect");
        close(sock);
        return 1;
    }

    printf("Connected to server!\n");

    printf("Enter request (example: READ test.txt): ");
    fgets(request, BUFFER_SIZE, stdin);

    send(sock, request, strlen(request), 0);

    memset(response, 0, BUFFER_SIZE);

    int bytes_received = recv(sock, response, BUFFER_SIZE - 1, 0);

    if (bytes_received > 0) {
        response[bytes_received] = '\0';

        printf("\nServer response:\n");
        printf("%s\n", response);
    }
    else {
        printf("No response received.\n");
    }

    close(sock);

    return 0;
}
