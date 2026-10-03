# Install Docker on Linux — tutorial video

A real-speed walkthrough of installing Docker Engine on Ubuntu 24.04, for the Companion Hub
setup guide. Two parts: finding the steps on docs.docker.com, then running them in a terminal.

Nothing here is simulated. The website is the live docs page; the terminal is a real install
recorded in a throwaway container, replayed at the speed it happened.

## What's here

| Path | What |
|---|---|
| `storyboard.json` | The cut: intro, website clip, four terminal clips, outro |
| `assets/video/website.mp4` | docs.docker.com: type the URL, open "Install using the apt repository", copy the block |
| `assets/video/terminal-1..4.mp4` | `apt update` + password, paste the block, `apt install`, `hello-world` |
| `assets/shots/*.png` | 1920×1080 stills for the blog post |
| `tools/` | The recorders that produced the clips |

## Render

```bash
KIT=../../../CI-Common/packages/video-kit/bin/ci-video.ts   # adjust to your checkout
node --experimental-strip-types $KIT build
node --experimental-strip-types $KIT check
node --experimental-strip-types $KIT render   # -> out/docker-linux-install-{landscape,portrait}.mp4
```

`--experimental-strip-types` is only needed on Node older than 22.18.

## Re-record the clips

Needs Docker, ffmpeg, Python 3 and Playwright's Chromium. Run from `tools/`.

```bash
# Terminal: a real install in a disposable systemd Ubuntu 24.04 container.
python3 record_terminal.py install.cast
npm i @xterm/xterm@5.5.0 playwright@1.62.1
node render_terminal.mjs install.cast terminal.mp4 ../assets/shots

# Website: the live docs page, frame by frame at 30 fps.
node record_website.mjs ../assets/video/website.mp4 ../assets/shots
```

Then split `terminal.mp4` at the pauses between commands and update each clip's `seconds`
in `storyboard.json` to its real duration (`ffprobe`).

How the recordings stay honest:

- **Typing** is sent one keystroke at a time into a real pty with human timing (55–150 ms per
  key, longer at spaces, the odd hesitation). The long docs block is pasted, as a reader would.
- **The container** is pre-loaded with the packages an Ubuntu desktop already has
  (`preinstall.txt`) and boots systemd, so `apt install` shows the same 10 packages a desktop
  user sees and Docker starts on its own. The sudo password belongs to the throwaway container
  and is never echoed.
- **The website** is recorded in a separate browser that blocks Docker's cookie and analytics
  scripts (no consent is given) and hides the promo strip above the header. To show the page
  inside a drawn browser window, that browser drops the page's `X-Frame-Options` header.
  Nothing on the page is changed beyond that.
- **Copy feedback** uses the site's own check icon, driven on the video clock rather than the
  site's 2-second wall-clock timer.
