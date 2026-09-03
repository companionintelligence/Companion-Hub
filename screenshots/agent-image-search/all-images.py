#!/usr/bin/env python3
"""
Capture the first Google Image result via browser screenshot for each app in the catalog.
Uses Playwright to open the page and screenshot the first image element directly
(no URL extraction - captures what the browser renders).

Usage:
  pip install -r requirements.txt
  playwright install chromium
  python all-images.py [--limit N] [--headed]

Output: PNG thumbnails (256x256) in thumbnails/ subfolder.
"""

import argparse
import io
import json
import sys
from pathlib import Path
from urllib.parse import quote_plus

from PIL import Image

# Paths relative to script location
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent  # CI-OS-Hub
DEFAULT_CATALOG = REPO_ROOT / "e2e" / "generated" / "catalog.json"
DEFAULT_OUTPUT = SCRIPT_DIR / "thumbnails"
THUMBNAIL_SIZE = (256, 256)


def load_catalog(path: Path) -> list[dict]:
    """Load app catalog: list of {id, name, storeSlug, ...}"""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def screenshot_first_image(page, query: str, use_duckduckgo: bool = False) -> bytes | None:
    """
    Open Google Images (or DuckDuckGo) in browser, find first image result,
    and capture it with a screenshot. No URL extraction - just what's rendered.
    Returns PNG bytes or None on failure.
    """
    encoded = quote_plus(f"{query} logo")
    if use_duckduckgo:
        url = f"https://duckduckgo.com/?q={encoded}&iax=images&ia=images"
        selectors = [".tile--img__img", "img[data-id]", "img[src*='external']", "div[data-id] img"]
    else:
        url = f"https://www.google.com/search?q={encoded}&tbm=isch"
        selectors = [
            "div[data-id] img",
            "img.rg_i",
            "a[data-ved] img",
            "div[jscontroller] img",
            "#search div img",
        ]

    try:
        page.goto(url, wait_until="load", timeout=20000)
        page.wait_for_timeout(2500)  # Let image grid render

        img_locator = None
        for sel in selectors:
            locator = page.locator(sel).first
            try:
                if locator.count() > 0 and locator.is_visible():
                    img_locator = locator
                    break
            except Exception:
                continue

        if img_locator is None or img_locator.count() == 0:
            return None

        # Screenshot the element directly - captures what browser renders, no URL needed
        return img_locator.screenshot(type="png")
    except Exception as e:
        print(f"  [warn] {e}", file=sys.stderr)
        return None


def format_thumbnail(data: bytes, out_path: Path) -> bool:
    """Resize and save as PNG thumbnail."""
    try:
        img = Image.open(io.BytesIO(data))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img = img.resize(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
        img.save(out_path, "PNG", optimize=True)
        return True
    except Exception as e:
        print(f"  [warn] resize: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Download app thumbnails from Google Images")
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help="Path to catalog.json",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Directory to save thumbnails",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max number of apps to process (0 = all)",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip apps that already have a thumbnail",
    )
    parser.add_argument(
        "--use-duckduckgo",
        action="store_true",
        help="Use DuckDuckGo instead of Google",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser visibly (helps if headless is blocked)",
    )
    args = parser.parse_args()

    if not args.catalog.exists():
        print(f"Catalog not found: {args.catalog}", file=sys.stderr)
        sys.exit(1)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog(args.catalog)
    apps = catalog[: args.limit] if args.limit else catalog

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()

        for i, app in enumerate(apps):
            app_id = app.get("id") or app.get("name", "").lower().replace(" ", "-")
            name = app.get("name") or app_id
            out_path = args.output_dir / f"{app_id}.png"

            if args.skip_existing and out_path.exists():
                print(f"[{i + 1}/{len(apps)}] {name} (skip, exists)")
                continue

            print(f"[{i + 1}/{len(apps)}] {name}...", end=" ", flush=True)
            data = screenshot_first_image(page, name, use_duckduckgo=args.use_duckduckgo)
            if data:
                if format_thumbnail(data, out_path):
                    print("ok")
                else:
                    print("format failed")
            else:
                print("no image")
            page.wait_for_timeout(500)  # Be nice to the search engine

        browser.close()

    print(f"\nDone. Thumbnails in {args.output_dir}")


if __name__ == "__main__":
    main()
