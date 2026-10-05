# Install Companion Hub on Linux — tutorial video

A real-speed walkthrough of installing Companion Hub on an Ubuntu 24.04 server, following
**Option 2: Linux server (headless)** on the
[Installation](https://docs.ci.computer/docs/getting-started/installation) page. It picks up
where [`../docker-linux-install`](../docker-linux-install) ends: Docker Engine installed and the
user in the `docker` group.

Nothing here is simulated. The docs page and the Hub dashboard are live pages; the terminal is
a real install on a fresh Ubuntu 24.04 virtual machine, replayed at the speed it happened.

## What's here

| Path | What |
|---|---|
| `storyboard.json` | Intro, docs clip, three terminal clips, dashboard clip, outro |
| `assets/video/docs.mp4` | docs.ci.computer Installation → "Option 2: Linux server (headless)" |
| `assets/video/hub-1..3.mp4` | Paste the download + `apt install` lines, password, `y` → `companion-hub --detached` → `cihub status` |
| `assets/video/dashboard.mp4` | `localhost:5002` → the device registration screen |
| `assets/video/*-portrait.mp4` | The same clips fitted to 1080×1920 (placeholder vertical cut) |
| `assets/shots/*.png` | 1920×1080 stills for the blog post |
| `recording/hub.cast` | The raw terminal recording (asciicast v2, with step markers) |

## Render

```bash
KIT=../../../CI-Common/packages/video-kit/bin/ci-video.ts   # adjust to your checkout
node --experimental-strip-types $KIT build
node --experimental-strip-types $KIT check
node --experimental-strip-types $KIT render   # -> out/hub-linux-install-{landscape,portrait}.mp4
```

## Re-record

The recorders live in [`../docker-linux-install/tools/`](../docker-linux-install/tools); its
README covers setup (QEMU/KVM, the Ubuntu cloud image, npm packages). From that directory:

```bash
# Terminal: fresh VM with Docker Engine + docker group set up before recording starts.
KEEP_VM=1 python3 record_terminal.py hub ../../hub-linux-install/recording/hub.cast
node render_terminal.mjs ../../hub-linux-install/recording/hub.cast terminal.mp4

# Website clips. The dashboard one needs the VM still running (KEEP_VM=1 above);
# the VM's :5002 is forwarded to 127.0.0.1:15002.
node record_website.mjs ci-hub-install ../../hub-linux-install/assets/video/docs.mp4
node record_website.mjs hub-dashboard ../../hub-linux-install/assets/video/dashboard.mp4
python3 -c "import record_terminal as rt; rt.vm_cleanup()"
```

Split `terminal.mp4` just before the `start` and `status` markers in `hub.cast`, and set each
clip's `seconds` to its real duration.

## What a reviewer should know

- **The docs' Option 2 block fails on a fresh server.** Run as written, `companion-hub --detached`
  stops with "No reachable Docker engine found": the block installs Docker but never adds the
  user to the `docker` group, so a non-root user can't reach the socket. The video avoids this by
  following the Docker video, where that step is done. The docs block should gain
  `sudo usermod -aG docker $USER` and a log-out/in, or say Docker must be set up first.
- **Docker line skipped.** The VM starts with Docker installed, so the terminal pastes only the
  Hub lines from the block, and the docs clip hovers the block instead of copying all of it.
- **The dashboard address.** The page is the VM's own Hub at `:5002`, reached through a port
  forward on `127.0.0.1:15002`; the drawn address bar shows `localhost:5002`, which is the
  address `cihub status` prints. The Device ID on screen belongs to a throwaway VM. That clip
  was recorded from a second fresh VM after the same install, run off camera.
- **The 52-second hold** while `companion-hub --detached` starts is the real first start,
  pulling the Hub's images.
- **`apt`'s "Download is performed unsandboxed…" notice** is real and appears for anyone who
  installs a `.deb` from their home folder, as the docs do.
