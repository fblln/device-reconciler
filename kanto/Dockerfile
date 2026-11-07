# Eclipse Kanto's local-digital-twins, in a container, because the project does
# not publish one.
#
# Kanto ships .deb, .rpm and .tar.gz for linux x86_64/arm64/armv7 and nothing
# else: no image on Docker Hub, none under the eclipse-kanto org. It is built to
# be installed on a device as systemd units. The tarball is plain static Go
# binaries, though, so an image is a download and a COPY.
FROM debian:13-slim

ARG KANTO_VERSION=1.0.0
ARG TARGETARCH=arm64

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/kanto
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) k=linux_x86_64 ;; \
      arm64) k=linux_arm64 ;; \
      armhf) k=linux_armv7 ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o kanto.tar.gz \
      "https://github.com/eclipse-kanto/kanto/releases/download/v${KANTO_VERSION}/kanto_${KANTO_VERSION}_${k}.tar.gz" \
 && tar -xzf kanto.tar.gz local-digital-twins \
 && rm kanto.tar.gz \
 && chmod +x local-digital-twins/local-digital-twins

WORKDIR /var/lib/kanto
CMD ["/opt/kanto/local-digital-twins/local-digital-twins", "-help"]
