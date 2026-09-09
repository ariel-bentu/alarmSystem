#pragma once

// Pure predicates for "is this TLS socket still usable?", split out of
// SslClientWithDns so they are native-testable — same split as HostResolver,
// StallDetector, IoDeadline and AuthSupervisor. No Arduino / mbedTLS types.

// True when the sslclient fd no longer refers to a usable socket.
//
// MUST BE <= 0, NOT < 0 (the 2026-09-09 regression). ssl_client.cpp
// stop_ssl_socket() sets socket = -1 at line 325, but line 346 then runs
// `memset(ssl_client, 0, sizeof(sslclient_context))`, which overwrites it with
// **0**. A live fd from lwip_socket() is > 0. So after a teardown the fd is 0,
// and a `< 0` test silently never matches — which is exactly why the first fix
// for the -76 hang shipped and still rebooted at 18.36h.
inline bool sslSocketIsGone(int fd) { return fd <= 0; }

// True when a return from the base available() is a hard failure (e.g. -76,
// MBEDTLS_ERR_NET_RECV_FAILED). 0 is NOT a failure here: a silent-but-open
// socket is the wall-clock deadline's job, not this predicate's.
inline bool sslReadFailed(int rc) { return rc < 0; }
