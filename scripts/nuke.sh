#!/bin/bash

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit
fi

echo "Nuking the system..."

# Remove all ci-hub data
rm -rf .internal

# Remove containers
docker rm -f ci-hub ci-hub-reverse-proxy ci-hub-db ci-hub-queue

# Remove docker volumes
docker volume rm ci_hub_pgdata
