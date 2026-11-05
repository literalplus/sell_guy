#!/usr/bin/env bash

set -e
set -o pipefail
set -o xtrace

# IMPORTANT: For this to work, you need to
#   pacman -Syu qemu-user-static qemu-user-static-binfmt

BASE="registry.lit.plus"

function build_and_push () {
    if podman manifest exists $1; then
        podman manifest rm $1
    fi

    if podman image exists $1; then
        podman image rm $1
    fi

    podman manifest create $1
    podman build --platform linux/amd64,linux/arm64 --manifest $1 -f ./$2/Dockerfile .
    podman manifest push $1
}

build_and_push "$BASE/sell-guy:latest" .
