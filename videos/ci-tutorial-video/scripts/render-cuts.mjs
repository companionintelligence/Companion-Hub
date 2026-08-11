/**
 * Render every cut as a transparent compositing layer.
 *
 * THE FLAGS ARE LOAD-BEARING, ALL FOUR. `--codec=prores --prores-profile=4444`
 * on its own produces `yuv422p12le` — a file with NO alpha channel, which looks
 * perfect until it is dropped over something that is not black.
 * `--pixel-format=yuva444p10le` is what actually asks for alpha, and Remotion
 * rejects it unless `--image-format=png` accompanies it, because a JPEG
 * intermediate cannot carry transparency through. They live here rather than in
 * anyone's shell history so a rebuild cannot quietly lose the alpha.
 *
 * Usage:
 *   node scripts/render-cuts.mjs                  # everything, both formats
 *   node scripts/render-cuts.mjs --only hub-cut-03
 *   node scripts/render-cuts.mjs --format portrait
 *   node scripts/render-cuts.mjs --preview        # also write flattened mp4s
 */
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = process.env.CUTS_DIR ?? "/home/ci/devel/ci/cuts";

/** The ground the previews are flattened onto — reference viewing only. */
const GROUND = "#041620";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes(name);

const only = arg("--only");
const wantFormat = arg("--format");
const withPreview = has("--preview");

// The cut list is TypeScript inside the Remotion bundle, so ask Remotion for the
// compositions rather than duplicating the list here and letting it drift.
const listed = execFileSync("npx", ["remotion", "compositions"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
})
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .filter((c) => c[0]?.startsWith("hub-cut-"))
  .map(([id, , size]) => ({
    id,
    format: id.endsWith("-portrait") ? "portrait" : "landscape",
    cut: id.replace(/-(portrait|landscape)$/, ""),
    size,
  }))
  .filter((c) => (only ? c.cut === only : true))
  .filter((c) => (wantFormat ? c.format === wantFormat : true));

if (listed.length === 0) {
  console.error("no compositions matched — check --only / --format");
  process.exit(1);
}

console.log(`rendering ${listed.length} layer(s) -> ${OUT}`);

for (const c of listed) {
  const dir = path.join(OUT, c.cut);
  fs.mkdirSync(dir, {recursive: true});
  const mov = path.join(dir, `${c.cut}-${c.format}.mov`);

  execFileSync(
    "npx",
    [
      "remotion", "render", c.id, mov,
      "--codec=prores",
      "--prores-profile=4444",
      "--pixel-format=yuva444p10le",
      "--image-format=png",
      "--muted",
      "--log=error",
    ],
    {cwd: ROOT, stdio: "inherit"},
  );

  // Fail loudly rather than shipping a layer with no alpha.
  const fmt = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt",
     "-of", "default=nw=1:nk=1", mov],
    {encoding: "utf8"},
  ).trim();
  if (fmt !== "yuva444p12le") {
    throw new Error(`${c.id}: rendered ${fmt}, expected yuva444p12le — the alpha channel is missing`);
  }

  if (withPreview) {
    const [w, h] = c.size.split("x");
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-y",
       "-f", "lavfi", "-i", `color=c=${GROUND.replace("#", "0x")}:s=${w}x${h}:r=30`,
       "-i", mov,
       "-filter_complex", "[0:v][1:v]overlay=shortest=1,format=yuv420p",
       "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-movflags", "+faststart",
       path.join(dir, `preview-${c.format}.mp4`)],
      {stdio: "inherit"},
    );
  }

  console.log(`  ✓ ${c.id}  ${fmt}`);
}

console.log("done");
