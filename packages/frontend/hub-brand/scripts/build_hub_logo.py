#!/usr/bin/env python3
"""Companion Hub logo builder.

Mark: a solid core (the Companion) ringed by facets (the apps docked on it), cut
by transparent gaps, in the CI mark's three-teal ramp. The gaps are circular
arcs that leave the core tangentially and sweep out to the rim. On a Smith chart
all resistance circles are tangent at one point and all reactance arcs pass
through it; the mark stylizes that single meeting point, which is what a hub is.
Flat paths only; no masks, strokes or filters in the mark files.

Usage: build_hub_logo.py HUB_BRAND_DIR [--mask-reference]   (writes HUB_BRAND_DIR/logos/*.svg)
"""
import math, os, re, sys

# ----- palette: the CI mark's own ramp (see CI-Common/assets/logos/README.md) -----
C_DARK, C_MID, C_LIGHT = "#066c80", "#1fa89e", "#3ae7ba"
TILE_BG, TILE_BG2 = "#041620", "#0c323c"          # canon dark bg / dark card

CX = CY = 100.0


# ------------------------------------------------------------------ geometry
def circ_circ(p0, r0, p1, r1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    d = math.hypot(dx, dy)
    a = (r0 * r0 - r1 * r1 + d * d) / (2 * d)
    h2 = r0 * r0 - a * a
    if h2 < -1e-6:
        raise ValueError("no intersection")
    h = math.sqrt(max(h2, 0.0))
    ux, uy = dx / d, dy / d
    mx, my = p0[0] + a * ux, p0[1] + a * uy
    return [(mx + h * -uy, my + h * ux), (mx - h * -uy, my - h * ux)]


def dist(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1])


def sweep(p1, p2, ctr):
    cross = (p1[0] - ctr[0]) * (p2[1] - ctr[1]) - (p1[1] - ctr[1]) * (p2[0] - ctr[0])
    return 1 if cross > 0 else 0


def f(n):
    return f"{n:.3f}".rstrip("0").rstrip(".")


def arc(p2, r, sw):
    return f"A{f(r)} {f(r)} 0 0 {sw} {f(p2[0])} {f(p2[1])}"


class Mark:
    """One hub mark: core + bands of facets, n spokes."""

    def __init__(self, n=6, R=92.0, r0=34.0, bands=((62.0, "b"),), gap=3.6, rho=64.0,
                 phase=-75.0):
        self.n, self.R, self.r0, self.gap, self.rho, self.phase = n, R, r0, gap, rho, phase
        self.h = gap / 2
        h = self.h
        # radial bands of facets: [(ra, rb, cls)], with a gap centred on every internal circle
        self.bands = []
        lo = r0 + h
        for (rcut, cls) in bands:
            self.bands.append((lo, rcut - h, cls))
            lo = rcut + h
        self.bands.append((lo, R, "a"))
        # classes: outermost 'a' (dark), middle 'b', core 'c'
        self.centres = []
        for k in range(n):
            th = math.radians(phase + k * 360.0 / n)
            self.centres.append((CX + (r0 + rho) * math.cos(th), CY + (r0 + rho) * math.sin(th)))

    def fval(self, k, p):
        return dist(p, self.centres[k % self.n]) - self.rho

    def facet(self, k, ra, rb):
        """The facet ahead of spoke k and behind spoke k+1.

        Each spoke is a thin strip |f| <= h whose inner edge (f = +h, radius rho+h)
        faces the core and whose outer edge (f = -h, radius rho-h) is the one that
        runs tangent to the core ring. Facet k is closed on one side by spoke k's
        inner edge and on the other by spoke k+1's outer edge. A spoke circle meets
        each band circle twice; only the intersection ahead of the spoke's start
        angle lies on the drawn half-arc.
        """
        h, n = self.h, self.n
        k1 = (k + 1) % n
        Fk = (self.centres[k], self.rho + h)
        Ek1 = (self.centres[k1], self.rho - h)
        c = (CX, CY)

        def forward(circle, rad, theta_deg):
            cands = circ_circ(circle[0], circle[1], c, rad)

            def ahead(p):
                a = math.degrees(math.atan2(p[1] - CY, p[0] - CX)) - theta_deg
                return (a + 180.0) % 360.0 - 180.0
            return max(cands, key=ahead)

        th_k = self.phase + k * 360.0 / n
        th_k1 = self.phase + (k + 1) * 360.0 / n
        A = forward(Fk, ra, th_k); B = forward(Fk, rb, th_k)
        C = forward(Ek1, rb, th_k1); D = forward(Ek1, ra, th_k1)
        d = f"M{f(A[0])} {f(A[1])}"
        d += arc(B, self.rho + h, sweep(A, B, Fk[0]))
        d += arc(C, rb, sweep(B, C, c))
        d += arc(D, self.rho - h, sweep(C, D, Ek1[0]))
        d += arc(A, ra, sweep(D, A, c))
        return d + "Z"

    def paths(self, colour):
        """-> [(class, d)] ; core first? no: outer first so file order = back to front."""
        out = []
        for (ra, rb, cls) in reversed(self.bands):
            for k in range(self.n):
                out.append((cls, self.facet(k, ra, rb)))
        rc = self.r0 - self.h
        out.append(("c", f"M{f(CX - rc)} {f(CY)}A{f(rc)} {f(rc)} 0 1 1 {f(CX + rc)} {f(CY)}"
                         f"A{f(rc)} {f(rc)} 0 1 1 {f(CX - rc)} {f(CY)}Z"))
        return out

    # ---- svg
    def body(self, mono=False, flat_fill=None):
        by = {"a": [], "b": [], "c": []}
        for cls, d in self.paths(None):
            by[cls].append(d)
        s = ""
        for cls in ("a", "b", "c"):
            if by[cls]:
                s += f'<path class="hub-{cls}" d="{"".join(by[cls])}"/>'
        return s

    def style(self, mono=False):
        if mono:
            return "<style>.hub-a,.hub-b,.hub-c{fill:currentColor}</style>"
        return f"<style>.hub-a{{fill:{C_DARK}}}.hub-b{{fill:{C_MID}}}.hub-c{{fill:{C_LIGHT}}}</style>"

    def svg(self, view="clear", mono=False, title="Companion Hub", size=None):
        pad = (2 * self.R) / 4
        if view == "tight":
            vb = (CX - self.R, CY - self.R, 2 * self.R, 2 * self.R)
        else:
            vb = (CX - self.R - pad, CY - self.R - pad, 2 * self.R + 2 * pad, 2 * self.R + 2 * pad)
        w = size or vb[2]
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(vb[0])} {f(vb[1])} {f(vb[2])} {f(vb[3])}" '
                f'width="{f(w)}" height="{f(w * vb[3] / vb[2])}" role="img" aria-labelledby="t">'
                f'<title id="t">{title}</title><defs>{self.style(mono)}</defs>{self.body(mono)}</svg>')


# the three shipped constructions
def hub_mark():          # full: core + mid ring + outer ring
    return Mark(n=6, R=92, r0=34, bands=((62, "b"),), gap=3.6, rho=64, phase=-75)


def hub_mark_small():    # 48 px and below: no mid ring, wider gaps, bigger core
    return Mark(n=6, R=95, r0=38, bands=(), gap=7.5, rho=60, phase=-75)


# ------------------------------------------------------------------ mask reference (prototype math)
def mask_reference(m: Mark):
    h2 = m.gap
    g = []
    for k in range(m.n):
        th = math.radians(m.phase + k * 360.0 / m.n)
        p0 = (CX + m.r0 * math.cos(th), CY + m.r0 * math.sin(th))
        ctr = m.centres[k]
        phi = 0.0
        while True:
            phi += 0.002
            a = th - phi
            x = ctr[0] + m.rho * -math.cos(a); y = ctr[1] + m.rho * -math.sin(a)
            if dist((x, y), (CX, CY)) > m.R + 6:
                break
        g.append(f'<path d="M{f(p0[0])} {f(p0[1])}A{f(m.rho)} {f(m.rho)} 0 0 0 {f(x)} {f(y)}"/>')
    cuts = [m.r0] + [m.bands[i][1] + m.h for i in range(len(m.bands) - 1)]
    rings = "".join(f'<circle cx="100" cy="100" r="{f(r)}"/>' for r in cuts)
    discs = f'<circle cx="100" cy="100" r="{f(m.R)}" fill="{C_DARK}"/>'
    for i in range(len(m.bands) - 1):
        discs += f'<circle cx="100" cy="100" r="{f(m.bands[i][1] + m.h)}" fill="{C_MID}"/>'
    discs += f'<circle cx="100" cy="100" r="{f(m.r0)}" fill="{C_LIGHT}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="800" height="800">'
            f'<defs><mask id="g" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">'
            f'<rect width="200" height="200" fill="#fff"/><g fill="none" stroke="#000" stroke-width="{f(m.gap)}">'
            f'{rings}{"".join(g)}</g></mask></defs><g mask="url(#g)">{discs}</g></svg>')


# ------------------------------------------------------------------ wordmark: reuse COMPANION, draw HUB
def _find_wordmark():
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.environ.get("CI_WORDMARK", "")]
    ups, d = [], here
    for _ in range(10):
        ups.append(d)
        d = os.path.dirname(d)
    for d in reversed(ups):                             # outermost first: the workspace-root CI-Common, not a nested copy
        cands.append(os.path.join(d, "CI-Common", "assets/logos/wordmark.svg"))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise SystemExit("CI-Common wordmark.svg not found; set CI_WORDMARK=/path/to/CI-Common/assets/logos/wordmark.svg")


CI_WORDMARK = _find_wordmark()
CAP, STEM, BAR, GAPX = 68.83, 12.76, 10.8, 18.6          # measured from the CI wordmark's INTELLIGENCE
BASE, TOP = 183.0, 114.17


def glyph_H(x0):
    W = 61.2
    ym = CAP / 2
    d = (f"M{f(x0)} 0H{f(x0 + STEM)}V{f(ym - BAR / 2)}H{f(x0 + W - STEM)}V0H{f(x0 + W)}V{f(CAP)}"
         f"H{f(x0 + W - STEM)}V{f(ym + BAR / 2)}H{f(x0 + STEM)}V{f(CAP)}H{f(x0)}Z")
    return d, W


def glyph_U(x0):
    W = 61.5
    Ro = W / 2
    yb = CAP - Ro
    rx, ry = Ro - STEM, Ro - BAR
    d = (f"M{f(x0)} 0H{f(x0 + STEM)}V{f(yb)}A{f(rx)} {f(ry)} 0 0 0 {f(x0 + W - STEM)} {f(yb)}V0H{f(x0 + W)}"
         f"V{f(yb)}A{f(Ro)} {f(Ro)} 0 0 1 {f(x0)} {f(yb)}Z")
    return d, W


def hub_word_paths():
    """HUB, regular weight, in the INTELLIGENCE line's coordinates (cap top = TOP, baseline = BASE)."""
    x = 2.4
    dH, wH = glyph_H(x); x += wH + GAPX
    dU, wU = glyph_U(x); x += wU + GAPX
    # B needs two separate (evenodd-safe) shapes + stem
    x0 = x
    ym = CAP * 0.485
    top_y1 = ym + BAR / 2
    bot_y0 = ym - BAR / 2
    side = 11.4
    xr_t, xr_b = 54.5, 57.5
    stem = f"M{f(x0)} 0H{f(x0 + STEM)}V{f(CAP)}H{f(x0)}Z"
    ro = top_y1 / 2
    X = x0 + xr_t - ro
    ci0, ci1 = BAR, bot_y0
    topD = (f"M{f(x0)} 0H{f(X)}A{f(ro)} {f(ro)} 0 0 1 {f(X)} {f(top_y1)}H{f(x0)}Z"
            f"M{f(x0 + STEM)} {f(ci0)}H{f(X)}A{f(ro - side)} {f((ci1 - ci0) / 2)} 0 0 1 {f(X)} {f(ci1)}H{f(x0 + STEM)}Z")
    ro2 = (CAP - bot_y0) / 2
    X2 = x0 + xr_b - ro2
    cj0, cj1 = top_y1, CAP - BAR
    botD = (f"M{f(x0)} {f(bot_y0)}H{f(X2)}A{f(ro2)} {f(ro2)} 0 0 1 {f(X2)} {f(CAP)}H{f(x0)}Z"
            f"M{f(x0 + STEM)} {f(cj0)}H{f(X2)}A{f(ro2 - side)} {f((cj1 - cj0) / 2)} 0 0 1 {f(X2)} {f(cj1)}H{f(x0 + STEM)}Z")
    width = (x0 + xr_b) - 2.4
    # H, U: plain paths; B: three paths with evenodd on the D's
    return (f'<g transform="translate(0 {f(TOP)})">'
            f'<path d="{dH}"/><path d="{dU}"/><path d="{stem}"/>'
            f'<path fill-rule="evenodd" d="{topD}"/><path fill-rule="evenodd" d="{botD}"/></g>'), (x0 + xr_b)


def companion_path():
    s = open(CI_WORDMARK).read()
    return re.findall(r'<path fill="[^"]+" d="([^"]+)"', s)[0]


WORD_W = 731.26


def wordmark_group(fill, dx=0.0, dy=0.0, center_hub=False):
    """COMPANION (bold, exact CI outlines) over HUB (regular)."""
    hub, hub_right = hub_word_paths()
    hub_w = hub_right - 2.4
    shift = (WORD_W - hub_w) / 2 - 2.4 if center_hub else 0.0
    return (f'<g transform="translate({f(dx)} {f(dy + 1.38)})" fill="{fill}">'
            f'<path d="{companion_path()}"/>'
            f'<g transform="translate({f(shift)} 0)">{hub}</g></g>')


# ------------------------------------------------------------------ lockups
def lockup(m: Mark, word_fill, mono=False):
    s = 223.13 / (2 * m.R)                       # same ink height as the CI mark in the CI lockup
    tx = -(CX - m.R) * s
    mark = (f'<g transform="translate({f(tx)} {f(tx)}) scale({f(s)})">{m.body(mono)}</g>')
    wm = wordmark_group(word_fill, 271.43, 18.54)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-70 -70 1142.68 362.43" width="1142.68" height="362.43" '
            f'role="img" aria-labelledby="t"><title id="t">Companion Hub</title><defs>{m.style(mono)}</defs>{mark}{wm}</svg>')


def lockup_below(m: Mark, word_fill, mono=False):
    D = 290.0
    s = D / (2 * m.R)
    W = WORD_W
    mx = (W - D) / 2
    mark = (f'<g transform="translate({f(mx - (CX - m.R) * s)} {f(-(CY - m.R) * s)}) scale({f(s)})">{m.body(mono)}</g>')
    wm = wordmark_group(word_fill, 0, D + 78 - 0 - 0.0 + 0, center_hub=True)
    # wordmark group draws COMPANION at y ~ 0 and HUB at TOP.. so shift up by nothing; height = 183+1.38
    H = D + 78 + 184.4
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-70 -70 {f(W + 140)} {f(H + 140)}" '
            f'width="{f(W + 140)}" height="{f(H + 140)}" role="img" aria-labelledby="t"><title id="t">Companion Hub</title>'
            f'<defs>{m.style(mono)}</defs>{mark}{wm}</svg>')


# ------------------------------------------------------------------ app icon tile
def app_icon(m: Mark, size=1024, square=False):
    """The mark on the canon dark tile. square=True is full-bleed with no rounding,
    for surfaces that apply their own mask (iOS, apple-touch-icon, maskable PWA icons)."""
    S = size
    rx = 0 if square else S * 0.2237
    ms = S * 0.62                                # mark diameter
    s = ms / (2 * m.R)
    off = (S - ms) / 2
    tx = off - (CX - m.R) * s
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}" role="img" aria-labelledby="t">'
            f'<title id="t">Companion Hub</title>'
            f'<defs>{m.style()}'
            f'<radialGradient id="bg" cx="50%" cy="42%" r="75%"><stop offset="0" stop-color="{TILE_BG2}"/><stop offset="1" stop-color="{TILE_BG}"/></radialGradient>'
            f'<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="{C_LIGHT}" stop-opacity=".34"/>'
            f'<stop offset=".55" stop-color="{C_LIGHT}" stop-opacity=".08"/><stop offset="1" stop-color="{C_LIGHT}" stop-opacity="0"/></radialGradient></defs>'
            f'<rect width="{S}" height="{S}" rx="{f(rx)}" fill="url(#bg)"/>'
            f'<circle cx="{S / 2}" cy="{S / 2}" r="{f(ms * 0.78)}" fill="url(#glow)"/>'
            f'<g transform="translate({f(tx)} {f(tx)}) scale({f(s)})">{m.body()}</g></svg>')


# ------------------------------------------------------------------ main
def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    M, S = hub_mark(), hub_mark_small()
    files = {
        "mark.svg": M.svg("clear"),
        "mark-tight.svg": M.svg("tight"),
        "mark-mono.svg": M.svg("tight", mono=True),
        "mark-small.svg": S.svg("tight"),
        "mark-small-mono.svg": S.svg("tight", mono=True),
        "lockup.svg": lockup(M, C_MID),
        "lockup-on-light.svg": lockup(M, C_DARK),
        "lockup-mono.svg": lockup(M, "currentColor", mono=True),
        "lockup-below.svg": lockup_below(M, C_MID),
        "lockup-below-on-light.svg": lockup_below(M, C_DARK),
        "app-icon.svg": app_icon(M),
        "app-icon-square.svg": app_icon(M, square=True),
        "app-icon-small.svg": app_icon(S),            # tile shown at 64 px and below: the small mark inside
    }
    logos = os.path.join(out, "logos")
    os.makedirs(logos, exist_ok=True)
    for k, v in files.items():
        open(os.path.join(logos, k), "w").write(v)
    if "--mask-reference" in sys.argv:
        open(os.path.join(out, "_ref-full.svg"), "w").write(mask_reference(M))
        open(os.path.join(out, "_ref-small.svg"), "w").write(mask_reference(S))
    print("wrote", len(files), "files to", logos)


if __name__ == "__main__":
    main()
