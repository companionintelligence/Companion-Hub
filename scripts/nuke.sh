#!/bin/bash
# Deletes a source checkout's Hub: every installed app, the Hub stack containers, the Postgres
# volume, and .internal. Legacy; prefer `cihub reset` (docs/RESET_RUNBOOK.md).
#
# Usage: sudo scripts/nuke.sh [--keep-apps]
#   --keep-apps  leave installed apps running and print what they still depend on

KEEP_APPS=0
for arg in "$@"; do
  case "$arg" in
    --keep-apps) KEEP_APPS=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--keep-apps]" >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_FOLDER="$(dirname "$SCRIPT_DIR")"
# shellcheck source-path=SCRIPTDIR source=lib/managed-app-teardown.sh
. "$SCRIPT_DIR/lib/managed-app-teardown.sh"

echo "Nuking the system..."

# Apps before the state they mount. See lib/managed-app-teardown.sh for what happens otherwise.
if [ "$KEEP_APPS" = "1" ]; then
  teardown_managed_apps keep
else
  teardown_managed_apps remove
fi

# Remove containers
docker rm -f ci-hub ci-hub-reverse-proxy ci-hub-db ci-hub-queue
remove_hub_stack_containers

# Remove docker volumes
docker volume rm ci_hub_pgdata

# Remove all ci-hub data. Anchored to the checkout, not the caller's working directory.
rm -rf "$ROOT_FOLDER/.internal"
