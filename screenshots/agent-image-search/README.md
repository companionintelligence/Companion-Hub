# App Thumbnail Image Downloader

Downloads the first Google Image search result for each app in the catalog and formats them as 256×256 PNG thumbnails for the localhost:5002 app store frontend.

## Setup

```bash
cd screenshots/agent-image-search

# Option A: Virtual environment (requires python3-venv)
python3 -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
playwright install chromium

# Option B: uv (if available)
uv pip install -r requirements.txt
uv run playwright install chromium
# Run with: uv run python all-images.py --limit 5
```

## Usage

```bash
# Download thumbnails for all apps (takes a while with 200+ apps)
python all-images.py

# Test with first 5 apps
python all-images.py --limit 5

# Skip apps that already have a thumbnail
python all-images.py --skip-existing

# Use DuckDuckGo instead of Google (if Google blocks)
python all-images.py --use-duckduckgo

# Custom catalog and output
python all-images.py --catalog /path/to/catalog.json --output-dir ./thumbnails
```

## Output

- Saves `{app-id}.png` (256×256) to the output directory (default: same folder as script)
- Images are suitable for app store metadata logos

## Using thumbnails in the app store

The frontend at localhost:5002 serves app images from:

- `/api/marketplace/apps/{appId}:{storeSlug}/image`

The backend looks for `metadata/logo.{jpg,png,svg,webp}` in each app directory. CI-App-Store is the source of truth for app names.

### Sync all thumbnails to CI-App-Store (recommended)

```bash
# Match thumbnails to their corresponding apps and copy to metadata/logo.png
python sync-thumbnails-to-appstore.py

# Preview without copying
python sync-thumbnails-to-appstore.py --dry-run

# Quiet mode (summary only)
python sync-thumbnails-to-appstore.py -q
```

### Manual copy

```bash
# Single app (run from agent-image-search/)
cp thumbnails/nextcloud.png ../../../CI-App-Store/apps/nextcloud/metadata/logo.png

# Batch (from thumbnails/ dir - one more ../ than agent-image-search)
APP_STORE="../../../../CI-App-Store/apps"
for f in *.png; do
  app_id="${f%.png}"
  if [ -d "$APP_STORE/$app_id" ]; then
    mkdir -p "$APP_STORE/$app_id/metadata"
    cp "$f" "$APP_STORE/$app_id/metadata/logo.png"
  fi
done
```
