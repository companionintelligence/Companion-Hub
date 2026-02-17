#!/usr/bin/env bash
set -o errexit
set -o nounset
set -o pipefail

VERSION="latest"
REPO="companionintelligence/ci-os-hub"

while [ -n "${1-}" ]; do
  case "$1" in
  --version)
    shift
    VERSION="$1"
    ;;
  *) echo "Option $1 not recognized" && exit 1 ;;
  esac
  shift
done

echo "Updating CI OS Hub to version ${VERSION}..."

echo "Pulling new images..."
docker compose pull

echo "Restarting services..."
docker compose up -d

echo "Update complete!"
