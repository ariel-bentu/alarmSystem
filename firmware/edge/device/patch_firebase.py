"""Apply our upstream fix to FirebaseClient before every build.

WHY THIS EXISTS
---------------
FirebaseClient's synchronous read loop cannot time out. `AsyncClient.h`:

    while (return_type == ret_continue && (httpCode == 0 || stage != finished))
    {
        sData->response.feedTimer(... sync_read_timeout_sec ...);   // re-arms
        sData->return_type = receive(sData);
        handleReadTimeout(sData);                                   // checks remaining()==0
        ...
    }

`feedTimer()` resets the deadline at the top of every iteration and
`handleReadTimeout()` reads it three lines later, so it can never be expired
when checked. `Timer::feed()` -> `setInterval()` -> `reset()` sets
`end = ts + period` from the CURRENT ts, so `end - ts == period` invariantly and
`ready()` (`ts >= end`) is never true — at ANY iteration rate.

When the peer drops a keep-alive connection mid-response, `available()` returns
0 forever, `readResponse()` becomes a no-op that still returns true, `receive()`
returns ret_continue, and the loop spins on `sys_idle()` (= `delay(0)`, which
does NOT feed the task watchdog) until the 60s TWDT reboots the board. Observed
twice on hardware: 10.0h and 18.36h uptime, both `phase='cloud:poll-config'`.

Full analysis and the reproducer: docs/upstream/ISSUE.md.
Filed upstream as https://github.com/mobizt/FirebaseClient/issues/333
(open as of 2026-09-10). If it is fixed and released, retire this script:
raise the lib_deps floor to the fixed version and drop the extra_scripts line.

THE PATCH
---------
Feed the timer only when the iteration actually made progress (respCtx.totalRead
increased, or respCtx.stage advanced). A live-but-slow transfer keeps extending
its deadline; a non-progressing loop expires at sync_read_timeout_sec.

NOT simply hoisting feedTimer() out of the loop: that turns a per-read timeout
into a flat deadline for the whole response and would kill large chunked
downloads, and readPayload() feeds per chunk anyway, so behaviour would differ
between chunked and non-chunked responses.

WHY IT FAILS LOUDLY
-------------------
.pio/ is gitignored and lib_deps is a caret range, so this patch is re-applied
after every install/update. If a future FirebaseClient release renumbers or
rewrites this code, a silent no-op would put us straight back to 60s watchdog
reboots with no signal. So a missing anchor is a HARD BUILD FAILURE, not a
warning. If that happens, re-read the upstream source and update ANCHOR//
REPLACEMENT — do not just delete this script.

Our SslClientWithDns workaround is deliberately kept as well: it steers the
library into its own teardown path from the Client side. The two are
independent, and either alone should prevent the hang.
"""

import os
import sys

Import("env")  # noqa: F821  (injected by PlatformIO/SCons)

LIB = "FirebaseClient"
TARGET = os.path.join("core", "AsyncClient", "AsyncClient.h")

# Verbatim from v2.2.13. Matched exactly (whitespace included) so any upstream
# reformatting trips the hard failure rather than silently not applying.
ANCHOR = """                while (sData->return_type == ret_continue && (sData->response.httpCode == 0 || sData->response.respCtx.stage != res_handler::response_stage_finished))
                {
                    sData->response.feedTimer(!sData->async && sync_read_timeout_sec > 0 ? sync_read_timeout_sec : -1);
                    sData->return_type = receive(sData);
"""

REPLACEMENT = """                while (sData->return_type == ret_continue && (sData->response.httpCode == 0 || sData->response.respCtx.stage != res_handler::response_stage_finished))
                {
                    // PATCHED LOCALLY (patch_firebase.py) — feed the read timer
                    // only when the iteration made progress. Feeding it
                    // unconditionally at the top of the loop reset the deadline
                    // that handleReadTimeout() checks three lines later, so it
                    // could never expire and a dead socket spun to the 60s TWDT.
                    // See docs/upstream/ISSUE.md.
                    const size_t fb_readBefore = sData->response.respCtx.totalRead;
                    const int fb_stageBefore = (int)sData->response.respCtx.stage;
                    if (fb_firstPass)
                    {
                        sData->response.feedTimer(!sData->async && sync_read_timeout_sec > 0 ? sync_read_timeout_sec : -1);
                        fb_firstPass = false;
                    }
                    sData->return_type = receive(sData);
                    if (sData->response.respCtx.totalRead != fb_readBefore || (int)sData->response.respCtx.stage != fb_stageBefore)
                        sData->response.feedTimer(!sData->async && sync_read_timeout_sec > 0 ? sync_read_timeout_sec : -1);
"""

# The loop needs a first-pass flag declared just above it, so the timer is armed
# once when the read begins and thereafter only on progress.
DECL_ANCHOR = """                sData->error.code = 0;
                while (sData->return_type == ret_continue && (sData->response.httpCode == 0"""

DECL_REPLACEMENT = """                sData->error.code = 0;
                bool fb_firstPass = true;  // patch_firebase.py
                while (sData->return_type == ret_continue && (sData->response.httpCode == 0"""

MARKER = "PATCHED LOCALLY (patch_firebase.py)"


def fail(msg):
    print("\n" + "=" * 72, file=sys.stderr)
    print("patch_firebase.py: PATCH FAILED — refusing to build", file=sys.stderr)
    print(msg, file=sys.stderr)
    print(
        "\nThis patch fixes an unbounded loop that reboots the board via the\n"
        "task watchdog (docs/upstream/ISSUE.md). Building without it would\n"
        "silently reintroduce that fault, so the build is stopped.\n\n"
        "If FirebaseClient was updated, re-read\n"
        "  src/core/AsyncClient/AsyncClient.h\n"
        "and update ANCHOR/REPLACEMENT in this script to match the new source.",
        file=sys.stderr,
    )
    print("=" * 72 + "\n", file=sys.stderr)
    env.Exit(1)  # noqa: F821


def find_lib():
    libdeps = env.subst("$PROJECT_LIBDEPS_DIR")  # noqa: F821
    envname = env.subst("$PIOENV")  # noqa: F821
    path = os.path.join(libdeps, envname, LIB, "src", TARGET)
    return path if os.path.isfile(path) else None


def main():
    path = find_lib()
    if path is None:
        # Library not installed yet (e.g. `pio pkg install` hasn't run). Not an
        # error: PlatformIO installs deps before the build proper, and this
        # script runs again then.
        print("patch_firebase.py: FirebaseClient not present yet, skipping")
        return

    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()

    if MARKER in src:
        print("patch_firebase.py: already applied")
        return

    if ANCHOR not in src:
        fail("Could not find the read-response loop in:\n  %s" % path)
    if DECL_ANCHOR not in src:
        fail("Could not find the loop preamble in:\n  %s" % path)

    src = src.replace(DECL_ANCHOR, DECL_REPLACEMENT, 1)
    src = src.replace(ANCHOR, REPLACEMENT, 1)

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)

    print("patch_firebase.py: applied progress-based read timeout to %s" % path)


main()
