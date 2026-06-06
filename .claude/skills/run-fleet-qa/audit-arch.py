#!/usr/bin/env python3
"""
audit-arch.py — ARM/x64 container coverage audit for CI-Marketplace apps.

For every service image across every app's docker-compose.json, determine which
CPU architectures the published image supports (linux/amd64, linux/arm64, ...),
then roll up per app: an app is ARM-ready only if EVERY image in its stack ships
linux/arm64.

It resolves architectures WITHOUT spending Docker Hub's registry pull-limit budget:
  - Docker Hub images -> hub.docker.com REST API (returns per-arch directly; throttled
    serially with 429 backoff because that API bursts-limits hard)
  - ghcr.io / lscr.io / codeberg / quay / etc -> registry v2 manifest-list API with an
    anonymous bearer token, falling back to the image config blob for single-arch tags
  - private ghcr.io/companionintelligence/* -> reported as "private" unless you
    `docker login ghcr.io` first and export GHCR_TOKEN

Usage:
  python3 audit-arch.py                      # audits ../CI-Marketplace/apps
  APP_STORE_DIR=/path/to/apps python3 audit-arch.py
  python3 audit-arch.py --cache arch-audit.json   # reuse prior results, only re-resolve misses

Outputs (next to this script): arch-audit.json (raw data) + arch-coverage.md (report).
"""
import json, os, sys, time, glob, datetime, argparse, urllib.request, urllib.error
import concurrent.futures as cf
from collections import defaultdict, Counter

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "ci-arch-audit/1.0"}
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
])

def get(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def parse_ref(image):
    tag = "latest"; name = image
    if ":" in image.rsplit("/", 1)[-1]:
        name, tag = image.rsplit(":", 1)
    if "@" in name:
        name = name.split("@", 1)[0]
    parts = name.split("/", 1); first = parts[0]
    if ("." in first or ":" in first or first == "localhost") and len(parts) > 1:
        return first, parts[1], tag
    return "docker.io", (name if "/" in name else "library/" + name), tag

def norm(arch, variant=""):
    if arch == "arm64": return "arm64"
    if arch == "arm": return "arm/" + (variant or "v7")
    if arch in ("amd64", "x86_64"): return "amd64"
    return arch + ("/" + variant if variant else "")

def dockerhub_arches(repo, tag):
    d = json.loads(get(f"https://hub.docker.com/v2/repositories/{repo}/tags/{tag}"))
    arches = set()
    for im in d.get("images", []):
        a = im.get("architecture")
        if not a or (im.get("os") and im["os"] != "linux"): continue
        arches.add(norm(a, im.get("variant") or ""))
    if not arches and d.get("architecture"):
        arches.add(norm(d["architecture"]))
    return arches

def registry_token(registry, repo):
    try:
        get(f"https://{registry}/v2/", timeout=15); return None
    except urllib.error.HTTPError as e:
        ch = e.headers.get("WWW-Authenticate", "")
    if not ch.lower().startswith("bearer"): return None
    p = {}
    for kv in ch[7:].split(","):
        if "=" in kv:
            k, v = kv.split("=", 1); p[k.strip()] = v.strip().strip('"')
    realm = p.get("realm")
    if not realm: return None
    tok = json.loads(get(f"{realm}?service={p.get('service','')}&scope=repository:{repo}:pull", timeout=15))
    return tok.get("token") or tok.get("access_token")

def registry_arches(registry, repo, tag):
    h = {"Accept": ACCEPT}
    # allow user-supplied ghcr token for private CI images
    if registry == "ghcr.io" and os.environ.get("GHCR_TOKEN"):
        h["Authorization"] = "Bearer " + os.environ["GHCR_TOKEN"]
    else:
        tok = registry_token(registry, repo)
        if tok: h["Authorization"] = "Bearer " + tok
    m = json.loads(get(f"https://{registry}/v2/{repo}/manifests/{tag}", headers=h, timeout=20))
    arches = set()
    if "manifests" in m:
        for sub in m["manifests"]:
            pl = sub.get("platform", {})
            if pl.get("architecture") in (None, "unknown"): continue
            if pl.get("os") and pl["os"] != "linux": continue
            arches.add(norm(pl["architecture"], pl.get("variant", "")))
    else:
        cfg = m.get("config", {}).get("digest")
        if cfg:
            cd = json.loads(get(f"https://{registry}/v2/{repo}/blobs/{cfg}", headers=h, timeout=20))
            if cd.get("architecture"):
                arches.add(norm(cd["architecture"], cd.get("variant", "")))
    return arches

def resolve(image):
    reg, repo, tag = parse_ref(image)
    try:
        arches = dockerhub_arches(repo, tag) if reg == "docker.io" else registry_arches(reg, repo, tag)
        return {"status": "ok" if arches else "unknown", "arches": sorted(arches), "registry": reg}
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return {"status": "http429", "arches": [], "registry": reg, "retry_after": e.headers.get("Retry-After")}
        return {"status": "private/auth" if e.code in (401, 403) else f"http{e.code}", "arches": [], "registry": reg}
    except Exception as e:
        return {"status": "err:" + type(e).__name__, "arches": [], "registry": reg}

def collect_images(apps_dir):
    img2apps = defaultdict(set); app_imgs = defaultdict(set)
    for f in glob.glob(os.path.join(apps_dir, "*/docker-compose.json")):
        app = os.path.basename(os.path.dirname(f))
        if app == "_template": continue
        try: d = json.load(open(f))
        except Exception: continue
        app_imgs.setdefault(app, set())
        for s in d.get("services", []):
            img = s.get("image", "")
            if not img or img.startswith("<"): continue
            img2apps[img].add(app); app_imgs[app].add(img)
    return img2apps, app_imgs

def rollup(app_imgs, results):
    rows = {}
    for app, images in app_imgs.items():
        per = {i: results.get(i, {}) for i in images}
        ok_sets = [set(v.get("arches", [])) for v in per.values() if v.get("status") == "ok"]
        has_arm = lambda a: any(x.startswith("arm64") for x in a)
        has_amd = lambda a: "amd64" in a
        n = len(images); ok = sum(1 for v in per.values() if v.get("status") == "ok")
        priv = sum(1 for v in per.values() if v.get("status") == "private/auth")
        amd_all = all(has_amd(a) for a in ok_sets) if ok_sets else False
        arm_all = ok == n and n > 0 and all(has_arm(a) for a in ok_sets)
        arm_any = any(has_arm(a) for a in ok_sets)
        if n == 0:
            verdict = "unknown"
        elif ok < n:
            verdict = "private" if priv and ok + priv == n else "unknown"
        elif arm_all:
            verdict = "both" if amd_all else "arm64-only"
        elif arm_any:
            verdict = "partial-arm"
        else:
            verdict = "amd64-only"
        rows[app] = {"verdict": verdict, "images": n, "resolved": ok,
                     "perImage": {i: per[i] for i in sorted(per)}}
    return rows

def write_report(apps, imgs, path):
    vc = Counter(r["verdict"] for r in apps.values())
    arches_of = lambda i: (",".join(imgs[i]["arches"]) if imgs.get(i, {}).get("status") == "ok" else imgs.get(i, {}).get("status", "?"))
    blockers = lambda a: [i for i, v in apps[a]["perImage"].items() if v.get("status") == "ok" and not any(x.startswith("arm64") for x in v.get("arches", []))]
    L = [f"# CI-Marketplace — ARM / x64 Container Coverage Audit", "",
         f"_Generated {datetime.date.today().isoformat()} · {len(apps)} apps · resolved via hub.docker.com REST + registry v2 manifest API (zero Docker Hub pull-limit cost)._", "",
         "**Why:** the current fleet nodes are all `x86_64`; an app with no `linux/arm64` build for its whole compose stack cannot install on an ARM CI-Hub appliance.", "",
         "## Summary", "", "| Verdict | Apps |", "|---|---:|"]
    for k in ("both", "amd64-only", "arm64-only", "partial-arm", "private", "unknown"):
        L.append(f"| {k} | {vc.get(k,0)} |")
    L += ["", "## amd64-only (no arm64 build)", "", "| App | amd64-only image(s) |", "|---|---|"]
    for a in sorted(a for a, r in apps.items() if r["verdict"] == "amd64-only"):
        L.append(f"| `{a}` | {', '.join('`%s`'%b for b in blockers(a))} |")
    L += ["", "## partial-arm (dependency image is amd64-only)", "", "| App | blocker(s) |", "|---|---|"]
    for a in sorted(a for a, r in apps.items() if r["verdict"] == "partial-arm"):
        L.append(f"| `{a}` | {', '.join('`%s`'%b for b in blockers(a))} |")
    L += ["", "## Full per-app matrix", "", "| App | Verdict | Images (arches) |", "|---|---|---|"]
    for a in sorted(apps):
        cell = "; ".join(f"`{i}` [{arches_of(i)}]" for i in sorted(apps[a]["perImage"]))
        L.append(f"| `{a}` | {apps[a]['verdict']} | {cell} |")
    open(path, "w").write("\n".join(L) + "\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apps-dir", default=os.environ.get("APP_STORE_DIR", os.path.join(HERE, "../../../../CI-Marketplace/apps")))
    ap.add_argument("--cache", default=os.path.join(HERE, "arch-audit.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "arch-audit.json"))
    ap.add_argument("--report", default=os.path.join(HERE, "arch-coverage.md"))
    args = ap.parse_args()
    apps_dir = os.path.abspath(args.apps_dir)
    if not os.path.isdir(apps_dir):
        sys.exit(f"apps dir not found: {apps_dir} (set APP_STORE_DIR or --apps-dir)")

    img2apps, app_imgs = collect_images(apps_dir)
    cache = {}
    if os.path.exists(args.cache):
        try: cache = json.load(open(args.cache)).get("images", {})
        except Exception: pass
    KEEP = {"ok", "private/auth", "http404"}
    todo = [i for i in sorted(img2apps) if cache.get(i, {}).get("status") not in KEEP]
    dh = [i for i in todo if parse_ref(i)[0] == "docker.io"]
    other = [i for i in todo if parse_ref(i)[0] != "docker.io"]
    print(f"{len(img2apps)} images across {len(app_imgs)} apps · cached={len(img2apps)-len(todo)} · resolving docker.io={len(dh)} other={len(other)}", flush=True)

    results = dict(cache)
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for img, info in zip(other, ex.map(resolve, other)):
            results[img] = info
    delay = 0.7
    for idx, img in enumerate(dh):
        for attempt in range(6):
            info = resolve(img)
            if info["status"] != "http429": break
            ra = info.get("retry_after")
            time.sleep(min(float(ra) if (ra and ra.isdigit()) else delay * (2 ** attempt), 30))
        results[img] = info
        if (idx + 1) % 25 == 0: print(f"  docker.io {idx+1}/{len(dh)}", flush=True)
        time.sleep(delay)

    apps = rollup(app_imgs, results)
    json.dump({"images": results, "apps": apps}, open(args.out, "w"), indent=1)
    write_report(apps, results, args.report)
    vc = Counter(r["verdict"] for r in apps.values())
    print("\nARM/x64 coverage:", dict(vc))
    print(f"wrote {args.out}\nwrote {args.report}")

if __name__ == "__main__":
    main()
