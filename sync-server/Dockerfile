FROM rust:1.94-slim AS builder

ARG HTTP_PROXY
ARG HTTPS_PROXY

WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/sync-server /usr/local/bin/sync-server

EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["sync-server"]
CMD ["--data-dir", "/data", "--port", "8080"]
