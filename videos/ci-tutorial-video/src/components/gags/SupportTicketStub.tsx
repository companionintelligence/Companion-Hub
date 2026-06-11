import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {fontFamily} from '../../brand/fonts';
import {useFormat} from '../../brand/format';

/**
 * c3-hub-controls: a small perforated support-ticket stub detaches from the
 * corner of the settings frame, drifts down-right like a falling leaf, and
 * dissolves before it leaves frame. Fires on "Every dial is yours," while the
 * caption "No tickets" is on screen.
 */
export const SupportTicketStub: React.FC = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fmt = useFormat();

  const start = durationInFrames * 0.62;
  const t = interpolate(frame, [start, durationInFrames - 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // falling-leaf path: down + drift right + gentle sway + rotate, fade before exit
  const x0 = fmt.isPortrait ? fmt.w * 0.66 : fmt.w * 0.74;
  const y0 = fmt.isPortrait ? fmt.h * 0.3 : fmt.h * 0.28;
  const x = x0 + t * 120 + Math.sin(t * 6) * 26;
  const y = y0 + t * (fmt.h * 0.28);
  const rot = Math.sin(t * 5) * 16 + t * 10;
  const opacity = interpolate(t, [0, 0.1, 0.7, 1], [0, 1, 1, 0]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        transform: `rotate(${rot}deg)`,
        fontFamily,
      }}
    >
      <div
        style={{
          display: 'flex',
          background: '#0e2630',
          border: '1px dashed rgba(155,180,187,0.5)',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: '0 10px 24px -12px rgba(1,9,14,0.7)',
        }}
      >
        {/* perforation column */}
        <div
          style={{
            width: 14,
            borderRight: '1px dashed rgba(155,180,187,0.45)',
            background:
              'repeating-linear-gradient(180deg, transparent 0 5px, rgba(155,180,187,0.25) 5px 7px)',
          }}
        />
        <div style={{padding: '8px 14px', color: '#9bb4bb'}}>
          <div style={{fontSize: 12, letterSpacing: 2, fontWeight: 600}}>SUPPORT TICKET</div>
          <div style={{fontSize: 11, letterSpacing: 1, marginTop: 3, opacity: 0.8}}>
            EST. WAIT: 6 DAYS
          </div>
        </div>
      </div>
    </div>
  );
};
