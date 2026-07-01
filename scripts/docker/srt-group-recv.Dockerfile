FROM ubuntu:22.04

ARG SRT_TAG=v1.5.5

RUN apt-get update -q \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
        build-essential \
        ca-certificates \
        cmake \
        g++ \
        git \
        libssl-dev \
        pkg-config \
        tclsh \
    && rm -rf /var/lib/apt/lists/*

# Build and install libsrt with bonding support
WORKDIR /src/srt
RUN git clone --branch "${SRT_TAG}" --depth 1 https://github.com/Haivision/srt.git .
RUN ./configure --prefix=/usr/local --enable-apps=OFF --enable-bonding \
    && make -j"$(nproc)" \
    && make install \
    && ldconfig

# Compile srt-group-recv against the installed libsrt
WORKDIR /src/app
COPY srt-bonding-test/srt-group-recv.c .
RUN g++ -O2 -o srt-group-recv srt-group-recv.c \
    $(pkg-config --cflags --libs srt) -lpthread -lssl -lcrypto -lm

# Package binary + non-system shared libs
RUN set -eux; \
    stage=/package; \
    mkdir -p "$stage/bin" "$stage/lib"; \
    install -m 755 srt-group-recv "$stage/bin/srt-group-recv"; \
    ldd "$stage/bin/srt-group-recv" | awk '/=> \// {print $3}' | while read -r lib; do \
        case "$lib" in \
            /lib/*/libc.so.*|/lib/*/libpthread.so.*|/lib/*/libm.so.*|/lib/*/libdl.so.*|/lib/*/ld-linux-*.so.*) ;; \
            *) cp -v "$lib" "$stage/lib/" ;; \
        esac; \
    done
