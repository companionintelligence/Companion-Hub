#!/usr/bin/env bash
#
# Recreate the org-level "Hub Telemetry" Sentry dashboard for Companion Hub.
#
# Covers the three Hub Sentry projects only:
#   - node-nestjs-hub-backend
#   - react-hub-frontend
#   - rust-hub-desktop-shell
#
# Prerequisites:
#   - `sentry` CLI installed and authenticated (`sentry login` / token)
#   - Access to org companion-intelligence
#
# Usage:
#   ./scripts/sentry-hub-telemetry-dashboard.sh
#
# Idempotent: deletes known widget titles (if present), then re-adds with a
# fixed layout. Text banner is applied via the REST API (CLI text widgets need
# an empty dataset that `widget add` does not expose cleanly).
#
# After a release, filter the live dashboard by hub_image_tag:vX.Y.Z or
# deployment_version to isolate that train.

set -euo pipefail

ORG="${SENTRY_ORG:-companion-intelligence}"
DASHBOARD_TITLE="${SENTRY_HUB_DASHBOARD_TITLE:-Hub Telemetry}"
ORG_SLASH="${ORG}/"

require_cli() {
  if ! command -v sentry >/dev/null 2>&1; then
    echo "error: sentry CLI not found on PATH" >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 required for JSON helpers" >&2
    exit 1
  fi
}

dashboard_exists() {
  sentry dashboard list "${ORG_SLASH}" --json 2>/dev/null | python3 -c "
import json, sys
title = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('data', [])
sys.exit(0 if any(d.get('title') == title for d in items) else 1)
" "${DASHBOARD_TITLE}"
}

ensure_dashboard() {
  if dashboard_exists; then
    echo "dashboard exists: ${DASHBOARD_TITLE}"
  else
    echo "creating dashboard: ${DASHBOARD_TITLE}"
    sentry dashboard create "${ORG_SLASH}" "${DASHBOARD_TITLE}" --json >/dev/null
  fi
}

dashboard_id() {
  sentry dashboard list "${ORG_SLASH}" --json | python3 -c "
import json, sys
title = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('data', [])
for d in items:
    if d.get('title') == title:
        print(d['id'])
        raise SystemExit(0)
raise SystemExit('dashboard not found: ' + title)
" "${DASHBOARD_TITLE}"
}

# Widget titles in layout order (used for delete-then-recreate).
WIDGET_TITLES=(
  "About"
  "Unresolved issues"
  "Prod error events"
  "App lifecycle failures"
  "Errors over time by project"
  "Errors by container tag"
  "Top unresolved issues"
  "Backend errors over time"
  "Transient DB / infra"
  "Failures by category"
  "Failures by error class"
  "Crash-phase events"
  "Frontend errors over time"
  "API-shaped frontend errors"
  "Shell errors over time"
  "Start / watchdog failures"
  "By deployment_version"
  "Affected devices"
)

delete_widgets() {
  local title
  for title in "${WIDGET_TITLES[@]}"; do
    # Text "About" may only exist via API; delete is best-effort.
    sentry dashboard widget delete "${ORG_SLASH}" "${DASHBOARD_TITLE}" \
      --title "${title}" --yes >/dev/null 2>&1 || true
  done
}

add_widget() {
  local title="$1"
  shift
  echo "  + ${title}"
  sentry dashboard widget add "${ORG_SLASH}" "${DASHBOARD_TITLE}" "${title}" "$@" >/dev/null
}

add_data_widgets() {
  # Row 1 — KPIs (issue dataset has no big_number; use compact table)
  add_widget "Unresolved issues" \
    --display table --dataset issue --query count \
    --where 'is:unresolved' --sort=-count --limit 5 \
    --group-by project \
    --col 0 --row 1 --width 2 --height 1

  add_widget "Prod error events" \
    --display big_number --dataset error-events --query count \
    --where 'environment:production' \
    --col 2 --row 1 --width 2 --height 1

  add_widget "App lifecycle failures" \
    --display big_number --dataset error-events --query count \
    --where 'failure_phase:[crash,post_start,install,start,update]' \
    --col 4 --row 1 --width 2 --height 1

  # Row 2 — Trends
  add_widget "Errors over time by project" \
    --display line --dataset error-events --query count \
    --where 'environment:production' \
    --group-by project \
    --col 0 --row 2 --width 3 --height 2

  add_widget "Errors by container tag" \
    --display line --dataset error-events --query count \
    --where 'environment:production' \
    --group-by hub_image_tag \
    --col 3 --row 2 --width 3 --height 2

  # Row 3 — What's on fire
  add_widget "Top unresolved issues" \
    --display table --dataset issue --query count \
    --where 'is:unresolved level:error' --sort=-count --limit 10 \
    --group-by title --group-by project \
    --col 0 --row 4 --width 6 --height 3

  # Row 4 — Backend
  add_widget "Backend errors over time" \
    --display area --dataset error-events --query count \
    --where 'project:node-nestjs-hub-backend environment:production' \
    --col 0 --row 7 --width 3 --height 2

  add_widget "Transient DB / infra" \
    --display bar --dataset error-events --query count \
    --where 'error_class:transient-db-unreachable OR message:"EAI_AGAIN"' \
    --col 3 --row 7 --width 3 --height 2

  # Row 5 — Marketplace apps
  add_widget "Failures by category" \
    --display categorical_bar --dataset error-events --query count \
    --where 'has:failure_category' \
    --group-by failure_category \
    --col 0 --row 9 --width 3 --height 2

  add_widget "Failures by error class" \
    --display bar --dataset error-events --query count \
    --where 'failure_category:[user_environment,app_config,unknown]' \
    --group-by error_class \
    --col 3 --row 9 --width 3 --height 2

  # Row 6 — Crash-phase
  add_widget "Crash-phase events" \
    --display table --dataset error-events --query count \
    --where 'failure_phase:crash' --sort=-count --limit 10 \
    --group-by title --group-by project \
    --col 0 --row 11 --width 6 --height 3

  # Row 7 — Frontend
  add_widget "Frontend errors over time" \
    --display area --dataset error-events --query count \
    --where 'project:react-hub-frontend environment:production' \
    --col 0 --row 14 --width 3 --height 2

  add_widget "API-shaped frontend errors" \
    --display bar --dataset error-events --query count \
    --where 'project:react-hub-frontend (TranslatableError OR has:http_status)' \
    --group-by http_status \
    --col 3 --row 14 --width 3 --height 2

  # Row 8 — Desktop shell
  add_widget "Shell errors over time" \
    --display area --dataset error-events --query count \
    --where 'project:rust-hub-desktop-shell' \
    --col 0 --row 16 --width 3 --height 2

  add_widget "Start / watchdog failures" \
    --display table --dataset error-events --query count \
    --where 'project:rust-hub-desktop-shell (hub.start OR tray.watchdog OR "Database bootstrap" OR compose)' \
    --sort=-count --limit 10 \
    --group-by title \
    --col 3 --row 16 --width 3 --height 2

  # Row 9 — Release readiness
  add_widget "By deployment_version" \
    --display bar --dataset error-events --query count \
    --where 'environment:production' \
    --group-by deployment_version \
    --col 0 --row 18 --width 3 --height 2

  add_widget "Affected devices" \
    --display big_number --dataset error-events \
    --query 'count_unique:user' \
    --where 'environment:production' \
    --col 3 --row 18 --width 3 --height 1
}

# Prepend the About text widget via PUT (merge with existing widgets).
apply_text_banner() {
  local id="$1"
  local tmp_get tmp_put
  tmp_get="$(mktemp)"
  tmp_put="$(mktemp)"
  trap 'rm -f "'"${tmp_get}"'" "'"${tmp_put}"'"' RETURN

  sentry api "organizations/${ORG}/dashboards/${id}/" >"${tmp_get}"
  python3 - "${tmp_get}" "${tmp_put}" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    d = json.load(f)

text = {
    "title": "About",
    "description": (
        "Hub-only. Filter by `hub_image_tag:vX.Y.Z` or `deployment_version` "
        "after release. Production-biased. Noise classes (dev, CancelledError, "
        "ACL, user_environment) are filtered or downgraded in code."
    ),
    "displayType": "text",
    "interval": "5m",
    "queries": [],
    "layout": {"x": 0, "y": 0, "w": 6, "h": 1, "minH": 1},
}

def slim(w):
    if w.get("displayType") == "text":
        return None
    out = {
        "title": w["title"],
        "displayType": w["displayType"],
        "interval": w.get("interval") or "5m",
        "queries": [],
        "layout": w.get("layout"),
    }
    if w.get("description") is not None:
        out["description"] = w["description"]
    if w.get("widgetType") is not None:
        out["widgetType"] = w["widgetType"]
    if w.get("limit") is not None:
        out["limit"] = w["limit"]
    for q in w.get("queries") or []:
        out["queries"].append({
            "name": q.get("name") or "",
            "fields": q.get("fields") or [],
            "aggregates": q.get("aggregates") or [],
            "columns": q.get("columns") or [],
            "fieldAliases": q.get("fieldAliases") or [],
            "conditions": q.get("conditions") or "",
            "orderby": q.get("orderby") or "",
            "isHidden": q.get("isHidden", False),
        })
    return out

widgets = [text]
for w in d.get("widgets") or []:
    s = slim(w)
    if s is not None:
        widgets.append(s)

payload = {
    "title": d["title"],
    "widgets": widgets,
    "projects": d.get("projects") or [],
    "environment": d.get("environment") or [],
    "filters": d.get("filters") or {},
}
with open(dst, "w") as f:
    json.dump(payload, f)
PY

  echo "  + About (text banner via API)"
  sentry api "organizations/${ORG}/dashboards/${id}/" --method PUT --input "${tmp_put}" >/dev/null
}

main() {
  require_cli
  ensure_dashboard
  local id
  id="$(dashboard_id)"
  echo "dashboard id: ${id}"
  echo "removing existing Hub Telemetry widgets (best-effort)…"
  delete_widgets
  echo "adding data widgets…"
  add_data_widgets
  echo "applying text banner…"
  apply_text_banner "${id}"
  echo
  echo "Hub Telemetry ready:"
  echo "  https://${ORG}.sentry.io/dashboard/${id}/"
  echo
  echo "Tip: filter by hub_image_tag:<release> or deployment_version after deploy."
}

main "$@"
