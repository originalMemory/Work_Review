#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# 从 .env 读取 BUILD_PROXY
if [ -f .env ]; then
  BUILD_PROXY=$(grep -E '^BUILD_PROXY=' .env | cut -d= -f2-)
fi

BUILD_ARGS=""
if [ -n "$BUILD_PROXY" ]; then
  echo "Using build proxy: $BUILD_PROXY"
  BUILD_ARGS="--build-arg HTTP_PROXY=$BUILD_PROXY --build-arg HTTPS_PROXY=$BUILD_PROXY"
fi

docker compose build $BUILD_ARGS
docker compose up -d
