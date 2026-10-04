# Install Docker on Linux — tutorial video

A real-speed walkthrough of installing Docker Engine on Ubuntu 24.04, following the
[Install Docker](https://docs.ci.computer/docs/getting-started/installing-docker) page on
docs.ci.computer: find the command, run it, add yourself to the `docker` group, log back in,
and check the engine and the Compose plugin.

Nothing here is simulated. The website is the live docs page; the terminal is a real install
recorded in a fresh Ubuntu 24.04 virtual machine, replayed at the speed it happened.

## What's here

| Path | What |
|---|---|
| `storyboard.json` | The cut: intro, website clip, four terminal clips, outro |
| `assets/video/website.mp4` | docs.ci.computer: type the URL, open "Install Docker Engine (Linux)", copy `curl -fsSL https://get.docker.com \| sh` |
| `assets/video/engine-1..4.mp4` | Paste + password + install → `usermod -aG docker` + `exit` → new login + `docker info` → `docker compose version` |
| `assets/video/*-portrait.mp4` | The same clips fitted to a 1080×1920 frame (placeholder vertical cut) |
| `assets/shots/*.png` | 1920×1080 stills for the blog post |
| `tools/` | The recorders that produced the clips, and the raw `engine.cast` recording |

## Render

```bash
KIT=../../../CI-Common/packages/video-kit/bin/ci-video.ts   # adjust to your checkout
node --experimental-strip-types $KIT build
node --experimental-strip-types $KIT check
node --experimental-strip-types $KIT render   # -> out/docker-linux-install-{landscape,portrait}.mp4
```

`--experimental-strip-types` is only needed on Node older than 22.18.

## Re-record the clips

Needs QEMU with KVM, `xorriso`, ffmpeg, Python 3 and Playwright's Chromium. Run from `tools/`.

```bash
npm i @xterm/xterm@5.5.0 playwright@1.62.1

# Ubuntu's official cloud image (about 600 MB); check it against SHA256SUMS.
mkdir -p vm && curl -fLo vm/noble.img \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

# Terminal: a real install in a fresh Ubuntu 24.04 VM, reached over SSH.
python3 record_terminal.py engine engine.cast
node render_terminal.mjs engine.cast terminal.mp4

# Website: the live docs page, frame by frame at 30 fps.
node record_website.mjs ci-engine ../assets/video/website.mp4 ../assets/shots
```

`engine.cast` carries asciicast markers (`"m"` events: `install`, `group`, `relogin`, `info`,
`compose`) at the moment each step starts. Split `terminal.mp4` just before each
marker, then set each clip's `seconds` in `storyboard.json` to its real duration (`ffprobe`).

The recorders also keep the earlier flow — Docker's own apt-repository steps from
docs.docker.com — as `record_terminal.py apt` and `record_website.mjs docker-apt`. That flow
still records in a container.

## How the recordings stay honest

- **Typing** is sent one keystroke at a time into a real pty with human timing (55–150 ms per
  key, longer at spaces, the odd hesitation). The command copied from the docs page is pasted,
  as a reader would.
- **The machine** is Ubuntu's official 24.04 cloud image booted under QEMU/KVM with 4 CPUs and
  8 GB, set up by cloud-init with a user `ci` who needs a password for `sudo`. Automatic apt
  updates are switched off so they can't hold the package lock mid-install, and `.hushlogin`
  keeps SSH's login banner out of the picture. Every run boots a fresh copy-on-write disk, so
  each recording starts from a clean install. The sudo password belongs to that VM and is
  never echoed.
- **Logging out and back in** is a real `exit` and a new SSH login, which is what makes the
  `docker` group take effect for `docker info`. The empty window at the start of that step is
  the login connecting.
- **The website** is recorded in a separate browser that blocks the site's analytics script.
  To draw the page inside a browser window it is shown in a frame (docs.docker.com additionally
  needs its `X-Frame-Options` header dropped, its cookie banner script blocked and its promo
  strip hidden). Nothing else on the page is changed.
- **Copy feedback** is the site's own check icon. Its reset timer is held so the icon stays
  visible to the end of the clip, because the page's timers run on wall-clock time while
  frames are rendered slower than real time.
