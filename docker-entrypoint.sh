#!/bin/sh
# Hub container entrypoint.
#
# Docker creates missing bind-mount source directories owned by root. The Hub
# process runs unprivileged (CI_HUB_CONTAINER_UID), so a root-owned /app/tunnel
# makes it impossible to write the Cloudflare tunnel token (EACCES) and the
# device gets stuck in the `tunnel_token_missing` degraded state. To make this
# self-heal on every start regardless of who created the dir, the container now
# starts as root, fixes ownership here, then drops to the Hub uid/gid — replacing
# the old compose `user:` directive.
set -eu

HUB_UID="${CI_HUB_CONTAINER_UID:-1000}"
HUB_GID="${CI_HUB_CONTAINER_GID:-1000}"
DOCKER_GID="${DOCKER_GID:-}"

# Root mode (e.g. Windows / Docker Desktop, where NTFS bind mounts require root):
# run the command as-is without dropping privileges.
if [ "$HUB_UID" = "0" ]; then
  exec "$@"
fi

# If we are already running unprivileged (e.g. a compose that still pins `user:`),
# we can neither chown the bind mount nor setpriv-drop (both need root). Run the
# command as-is instead of crash-looping on a failed privilege drop.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# Heal the tunnel bind mount so the Hub uid can write the tunnel token.
# Best-effort — never block boot on a chown failure.
if [ -d /app/tunnel ]; then
  chown -R "$HUB_UID:$HUB_GID" /app/tunnel 2>/dev/null || true
fi

# Drop privileges to the Hub uid/gid. Docker-socket access for the dropped process
# comes solely from adding DOCKER_GID as a supplementary group here: setpriv REPLACES
# the supplementary set (so the compose `group_add` does NOT survive the drop, and
# su-exec would clear the groups for a numeric uid). DOCKER_GID is supplied via the
# container env (compose defaults it to 973); if it is somehow unset we clear groups
# rather than leak root's, which means the Hub would lack socket access until it is set.
if [ -n "$DOCKER_GID" ]; then
  exec setpriv --reuid="$HUB_UID" --regid="$HUB_GID" --groups="$DOCKER_GID" -- "$@"
fi
exec setpriv --reuid="$HUB_UID" --regid="$HUB_GID" --clear-groups -- "$@"
