# Archived video references

This directory contains archived editorial reference material. The active Companion Hub HyperFrames build is in [`../video/`](../video/).

Live video generation across the platform runs on **HyperFrames**
(`CI-Engineering/projects/product-video-pipeline`), not Remotion — see `../video/` in
this repository for the current Companion Hub product video build. HyperFrames natively
covers everything this folder previously used Remotion for, including transparent
alpha-channel output (`hyperframes render --format webm|mov`) — see
[`ci-tutorial-video/README.md`](ci-tutorial-video/README.md#rebuilding-this-natively-in-hyperframes).

| Project | What it is |
|---|---|
| [`ci-tutorial-video/`](ci-tutorial-video/) | Static editorial reference (storyboard, narration audio, screenshots) for a full FTUE platform walkthrough (Portal → Hub → Marketplace). Originally a Remotion project; the Remotion install has been removed — see its README. |

