#!/usr/bin/env python3
"""
Sync thumbnails to CI-App-Store metadata.

Uses CI-App-Store as the source of truth: for each app directory in the app store,
copies the matching thumbnail (if it exists) to apps/{id}/metadata/logo.png.

Usage:
  python sync-thumbnails-to-appstore.py [--dry-run] [--thumbnails DIR] [--app-store DIR]

The backend serves app images from metadata/logo.{jpg,png,svg,webp}; PNG is used here.
"""

import argparse
import shutil
import sys
from pathlib import Path

# Paths relative to script location
SCRIPT_DIR = Path(__file__).resolve().parent
DEVEL_ROOT = SCRIPT_DIR.parent.parent.parent  # CI-OS-Hub -> devel
DEFAULT_THUMBNAILS = SCRIPT_DIR / "thumbnails"
DEFAULT_APP_STORE = DEVEL_ROOT / "CI-App-Store" / "apps"


def get_app_ids(app_store_dir: Path) -> list[str]:
    """Return sorted list of app directory names, excluding _template."""
    if not app_store_dir.is_dir():
        return []
    return sorted(
        d.name for d in app_store_dir.iterdir()
        if d.is_dir() and d.name != "_template"
    )


def main():
    parser = argparse.ArgumentParser(
        description="Sync thumbnails to CI-App-Store app metadata logos"
    )
    parser.add_argument(
        "--thumbnails",
        type=Path,
        default=DEFAULT_THUMBNAILS,
        help="Directory containing {app-id}.png thumbnail files",
    )
    parser.add_argument(
        "--app-store",
        type=Path,
        default=DEFAULT_APP_STORE,
        help="CI-App-Store apps directory (apps/)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be done without copying",
    )
    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Only print summary, not each copy",
    )
    args = parser.parse_args()

    if not args.thumbnails.is_dir():
        print(f"Thumbnails directory not found: {args.thumbnails}", file=sys.stderr)
        sys.exit(1)

    if not args.app_store.is_dir():
        print(f"App store directory not found: {args.app_store}", file=sys.stderr)
        sys.exit(1)

    app_ids = get_app_ids(args.app_store)
    copied = 0
    skipped_no_thumb = []
    skipped_no_metadata = []

    for app_id in app_ids:
        thumb_path = args.thumbnails / f"{app_id}.png"
        metadata_dir = args.app_store / app_id / "metadata"
        logo_path = metadata_dir / "logo.png"

        if not thumb_path.exists():
            skipped_no_thumb.append(app_id)
            continue

        if not metadata_dir.exists():
            if args.dry_run and not args.quiet:
                print(f"[dry-run] Would create {metadata_dir}")
            metadata_dir.mkdir(parents=True, exist_ok=True)

        if args.dry_run:
            if not args.quiet:
                print(f"[dry-run] Would copy {thumb_path.name} -> {app_id}/metadata/logo.png")
        else:
            shutil.copy2(thumb_path, logo_path)
            if not args.quiet:
                print(f"Copied {app_id}.png -> {app_id}/metadata/logo.png")

        copied += 1

    # Summary
    print()
    print(f"Matched & copied: {copied}/{len(app_ids)} apps")
    if skipped_no_thumb:
        print(f"Apps without thumbnail: {len(skipped_no_thumb)}")
        if len(skipped_no_thumb) <= 20:
            print("  ", ", ".join(skipped_no_thumb))
        else:
            print("  ", ", ".join(skipped_no_thumb[:20]), "...")

    # Orphan thumbnails (images with no matching app)
    thumb_files = {f.stem for f in args.thumbnails.glob("*.png")}
    app_set = set(app_ids)
    orphans = sorted(thumb_files - app_set)
    if orphans:
        print(f"\nOrphan thumbnails (no matching app): {len(orphans)}")
        if len(orphans) <= 15:
            print("  ", ", ".join(orphans))
        else:
            print("  ", ", ".join(orphans[:15]), "...")

    if args.dry_run:
        print("\n[DRY RUN - no files were modified]")


if __name__ == "__main__":
    main()
