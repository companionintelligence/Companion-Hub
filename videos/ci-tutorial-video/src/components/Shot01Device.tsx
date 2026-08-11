import React from 'react';
import {Img, staticFile} from 'remotion';
import {font} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {Format} from '../brand/format';
import {SHOT01, shot01Geometry} from '../brand/shot01';

/**
 * The illustrated device from shot-01 — phone in portrait, browser in
 * landscape — with a page scrolling inside it. Shared so the film scene
 * (`Shot01Scene`) and the standalone layer (`HubCut01`) cannot drift: the cut
 * exists to be composited under the film, so a device that differed by a pixel
 * between them would be worse than useless.
 *
 * Draws NO background and NO text. Both are the caller's business, which is
 * what lets the cut render on transparency.
 */
export const Shot01Device: React.FC<{
  fmt: Format;
  src: string;
  url?: string;
  /** 0..1 arrival, already eased. 1 = at rest. */
  slide: number;
  /** 0..1 page travel, already eased. */
  scroll: number;
  /**
   * Whether the plate may be enlarged so it has somewhere to scroll. A cut that
   * holds still must NOT be — enlarging a page 22% and cropping 11% off each
   * side buys travel it will never use, and costs the framing to do it.
   */
  travels?: boolean;
  /**
   * Live content to render in the aperture INSTEAD of the plate at `src`, laid
   * out at `contentWidth` design px and scaled to fit — the same factor a real
   * capture taken at that viewport would receive, so composed and photographed
   * screens sit at the same type size.
   */
  content?: (args: {width: number; height: number}) => React.ReactNode;
  contentWidth?: number;
  /**
   * Drawn over the plate in PLATE-PIXEL space, inside the scroller — so it
   * travels with the page, exactly like the UI it annotates. `k` is the plate's
   * display scale, for sizing anything that should stay a constant on-screen
   * size (a pointer) rather than a constant page size.
   */
  overlay?: (args: {k: number; plateW: number; plateH: number}) => React.ReactNode;
  /**
   * Drawn in APERTURE space, outside the scroller — pinned to the screen while
   * the page moves underneath. This is how a sticky action bar stays put.
   */
  pinned?: (args: {k: number; apertureW: number; apertureH: number}) => React.ReactNode;
}> = ({
  fmt,
  src,
  url,
  slide,
  scroll,
  travels = true,
  content,
  contentWidth,
  overlay,
  pinned,
}) => {
  const L = SHOT01.landscape;
  const {devW, devH, restX, restY, bezel, apertureW, apertureH, contentW, offX} =
    shot01Geometry(fmt);
  const x = offX + (restX - offX) * slide;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: restY,
        width: devW,
        height: devH,
        transform: `translateX(${x.toFixed(2)}px)`,
        borderRadius: fmt.isPortrait ? SHOT01.phoneRadius : SHOT01.browserRadius,
        border: `${bezel}px solid ${SHOT01.stroke}`,
        background: SHOT01.body,
        boxShadow: SHOT01.shadow,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {fmt.isPortrait ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: SHOT01.statusH,
            background: SHOT01.phoneStatus,
          }}
        >
          <div
            style={{
              width: SHOT01.notch.w,
              height: SHOT01.notch.h,
              borderRadius: SHOT01.notch.r,
              background: SHOT01.body,
            }}
          />
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: L.chromeH,
            padding: '0 18px',
            background: SHOT01.chrome,
            borderBottom: `1px solid ${SHOT01.chromeRule}`,
            fontFamily,
          }}
        >
          {/* All three dots are the same teal — the reference does not use
              macOS traffic-light colours; it is a drawing of a browser. */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: L.dot,
                height: L.dot,
                borderRadius: '50%',
                background: SHOT01.stroke,
              }}
            />
          ))}
          {url ? (
            <div
              style={{
                marginLeft: 14,
                fontSize: L.urlSize,
                fontWeight: font.weight.medium,
                color: SHOT01.textMuted,
              }}
            >
              {url}
            </div>
          ) : null}
        </div>
      )}

      <div
        style={{
          position: 'relative',
          width: apertureW,
          height: apertureH,
          overflow: 'hidden',
          background: SHOT01.aperture,
        }}
      >
        {content && contentWidth ? (
          (() => {
            const k = contentW / contentWidth;
            return (
              <div
                style={{
                  position: 'absolute',
                  left: Math.round((apertureW - contentW) / 2),
                  top: 0,
                  width: contentWidth,
                  height: apertureH / k,
                  transform: `scale(${k})`,
                  transformOrigin: 'top left',
                }}
              >
                {content({width: contentWidth, height: apertureH / k})}
              </div>
            );
          })()
        ) : (
          <ScrollingPlate
            src={src}
            contentW={contentW}
            apertureW={apertureW}
            apertureH={apertureH}
            progress={scroll}
            travels={travels}
            overlay={overlay}
          />
        )}
        {pinned ? (
          <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
            {pinned({k: contentW / 1, apertureW, apertureH})}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * The capture, width-fit and top-anchored inside the aperture, travelling only
 * as far as it genuinely overflows. A plate tall enough to scroll is left
 * exactly at its natural scale; only a viewport-sized shot gets enlarged to
 * manufacture travel (see `SHOT01.minTravel`).
 */
const ScrollingPlate: React.FC<{
  src: string;
  contentW: number;
  apertureW: number;
  apertureH: number;
  progress: number;
  travels: boolean;
  overlay?: (args: {k: number; plateW: number; plateH: number}) => React.ReactNode;
}> = ({src, contentW, apertureW, apertureH, progress, travels, overlay}) => {
  const [natural, setNatural] = React.useState<{w: number; h: number} | null>(null);

  const fitH = natural ? (natural.h * contentW) / natural.w : apertureH;
  const need = apertureH * (1 + SHOT01.minTravel);
  const k = travels && fitH < need ? need / fitH : 1;
  const w = Math.round(contentW * k);
  const h = Math.round(fitH * k);
  const overflow = Math.max(0, h - apertureH);

  return (
    <div
      style={{
        position: 'absolute',
        left: Math.round((apertureW - w) / 2),
        top: -(overflow * progress),
        width: w,
        height: h,
      }}
    >
      <Img
        src={staticFile(src)}
        onLoad={(e) => {
          const img = e.currentTarget;
          setNatural({w: img.naturalWidth, h: img.naturalHeight});
        }}
        style={{width: w, height: h, display: 'block'}}
      />
      {/* Plate-space overlays are scaled by the same factor as the plate, so a
          coordinate measured off the PNG lands on the same pixel on screen. */}
      {overlay && natural ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: natural.w,
            height: natural.h,
            transform: `scale(${w / natural.w})`,
            transformOrigin: 'top left',
          }}
        >
          {overlay({k: w / natural.w, plateW: natural.w, plateH: natural.h})}
        </div>
      ) : null}
    </div>
  );
};
