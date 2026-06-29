FROM ubuntu:22.04

ARG SRT_TAG=v1.5.5

RUN apt-get update -q \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
        build-essential \
        ca-certificates \
        cmake \
        git \
        libssl-dev \
        pkg-config \
        tclsh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone --branch "${SRT_TAG}" --depth 1 https://github.com/Haivision/srt.git .

RUN ./configure --prefix=/usr/local --enable-apps=ON \
    && make -j"$(nproc)"

RUN set -eux; \
    stage=/package; \
    mkdir -p "$stage/bin" "$stage/lib"; \
    bin="$(find /src -type f -name srt-live-transmit -perm -111 | head -1)"; \
    test -n "$bin"; \
    install -m 755 "$bin" "$stage/bin/srt-live-transmit"; \
    ldd "$stage/bin/srt-live-transmit" | awk '/=> \// {print $3}' | while read -r lib; do \
        case "$lib" in \
            /lib/*/libc.so.*|/lib/*/libpthread.so.*|/lib/*/libm.so.*|/lib/*/libdl.so.*|/lib/*/ld-linux-*.so.*) ;; \
            *) cp -v "$lib" "$stage/lib/" ;; \
        esac; \
    done
