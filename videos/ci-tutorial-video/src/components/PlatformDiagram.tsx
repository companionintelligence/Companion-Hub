import React from 'react';
import {spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {color, font, gradient, radius} from '../brand/theme';
import {fontFamily} from '../brand/fonts';
import {useFormat, Format} from '../brand/format';

type NodeDef = {
  id: string;
  label: string;
  sub: string;
  accent?: boolean;
  /** Landscape center (1920×1080 space) and portrait center (1080×1920 space). */
  land: [number, number];
  port: [number, number];
  /** Pop order — Hub first to match "At the center is the Hub" narration. */
  order: number;
};

const NODES: NodeDef[] = [
  {id: 'hub', label: 'Hub', sub: 'App runtime — your appliance', accent: true, land: [960, 540], port: [540, 980], order: 0},
  {id: 'portal', label: 'Portal', sub: 'Cloud control plane', land: [420, 290], port: [540, 420], order: 1},
  {id: 'marketplace', label: 'Marketplace', sub: 'App catalog', land: [1500, 290], port: [800, 700], order: 2},
  {id: 'server', label: 'Server', sub: 'Private memory brain', land: [420, 790], port: [280, 700], order: 3},
  {id: 'devices', label: 'Clients & devices', sub: 'Capture · XR · wearables', land: [1500, 790], port: [540, 1480], order: 4},
];

const LINKS: Array<[string, string]> = [
  ['portal', 'hub'],
  ['marketplace', 'hub'],
  ['server', 'hub'],
  ['devices', 'hub'],
];

/**
 * Animated Portal/Hub/Marketplace/Server/devices map with the Hub at center.
 * `porch` (0..1) brightens the porch light on the Hub card — the cold-open
 * cloud joke pays off against it. `cloudWord=false` swaps Portal's sub-label so
 * the word "cloud" is off-screen while clouds are being mocked.
 */
export const PlatformDiagram: React.FC<{porch?: number; cloudWord?: boolean}> = ({
  porch = 0,
  cloudWord = true,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fmt = useFormat();

  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const pos = (n: NodeDef): [number, number] => (fmt.isPortrait ? n.port : n.land);
  const [hx, hy] = pos(byId.hub);

  return (
    <div style={{position: 'absolute', inset: 0, fontFamily}}>
      <svg
        width={fmt.w}
        height={fmt.h}
        viewBox={`0 0 ${fmt.w} ${fmt.h}`}
        style={{position: 'absolute', inset: 0}}
      >
        {LINKS.map(([a, b], i) => {
          const [ax, ay] = pos(byId[a]);
          const [bx, by] = pos(byId[b]);
          const draw = spring({
            frame: frame - 14 - i * 6,
            fps,
            config: {damping: 200},
            durationInFrames: 30,
          });
          const len = Math.hypot(bx - ax, by - ay);
          return (
            <line
              key={`${a}-${b}`}
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={color.tealMid}
              strokeOpacity={0.55}
              strokeWidth={3}
              strokeDasharray={len}
              strokeDashoffset={len * (1 - draw)}
            />
          );
        })}
      </svg>

      <Roofline cx={hx} cy={hy} fmt={fmt} frame={frame} fps={fps} porch={porch} />

      {NODES.map((n) => {
        const [cx, cy] = pos(n);
        const pop = spring({
          frame: frame - n.order * 6,
          fps,
          config: {damping: 14, stiffness: 120},
          durationInFrames: 35,
        });
        const w = n.accent ? (fmt.isPortrait ? 440 : 460) : fmt.isPortrait ? 360 : 380;
        const sub = n.id === 'portal' && !cloudWord ? 'Control plane' : n.sub;
        return (
          <div
            key={n.id}
            style={{
              position: 'absolute',
              left: cx - w / 2,
              top: cy - 70,
              width: w,
              transform: `scale(${pop})`,
              background: n.accent ? color.cardHover : color.card,
              border: `1px solid ${n.accent ? color.accent2 : color.border}`,
              borderRadius: radius.xl,
              padding: '26px 32px',
              boxShadow: n.accent
                ? `0 0 ${60 + porch * 50}px rgba(25,198,200,${0.25 + porch * 0.25})`
                : '0 12px 28px -22px rgba(1,9,14,0.4)',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                color: n.accent ? color.accent : color.text,
                fontSize: n.accent ? 44 : 36,
                fontWeight: font.weight.semibold,
              }}
            >
              {n.label}
            </div>
            <div
              style={{
                color: color.textMuted,
                fontSize: 22,
                fontWeight: font.weight.body,
                marginTop: 6,
              }}
            >
              {sub}
            </div>
          </div>
        );
      })}

      {/* pulsing center orb behind the Hub card */}
      <div
        style={{
          position: 'absolute',
          left: hx - 40,
          top: hy - 40,
          width: 80,
          height: 80,
          borderRadius: 40,
          background: gradient.orb,
          filter: 'blur(34px)',
          opacity: 0.5 + 0.3 * Math.sin(frame / 12),
        }}
      />
    </div>
  );
};

/** A gabled roofline that draws over the Hub card, with a porch light. */
const Roofline: React.FC<{
  cx: number;
  cy: number;
  fmt: Format;
  frame: number;
  fps: number;
  porch: number;
}> = ({cx, cy, fmt, frame, fps, porch}) => {
  const draw = spring({frame: frame - 30, fps, config: {damping: 200}, durationInFrames: 22});
  const w = 300;
  const topY = cy - 70 - 70;
  const eaveY = cy - 70 - 18;
  const path = `M ${cx - w / 2} ${eaveY} L ${cx} ${topY} L ${cx + w / 2} ${eaveY}`;
  const lit = spring({frame: frame - 48, fps, config: {damping: 200}, durationInFrames: 16});
  const glow = lit * (0.85 + porch * 0.6);
  return (
    <svg
      width={fmt.w}
      height={fmt.h}
      viewBox={`0 0 ${fmt.w} ${fmt.h}`}
      style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}
    >
      <path
        d={path}
        fill="none"
        stroke={color.tealLight}
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={w * 1.2}
        strokeDashoffset={w * 1.2 * (1 - draw)}
        opacity={0.85}
      />
      <circle cx={cx} cy={eaveY + 6} r={6} fill={color.cyanBright} opacity={glow} />
      <circle cx={cx} cy={eaveY + 6} r={20 + porch * 14} fill={color.cyanBright} opacity={glow * 0.25} />
    </svg>
  );
};
