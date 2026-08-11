import React from 'react';
import {Img, staticFile} from 'remotion';
import {fontFamily} from '../brand/fonts';

/**
 * The Portal workspace, populated.
 *
 * THIS IS A COMPOSED SCREEN, NOT A CAPTURE — and that is a deliberate, directed
 * choice worth stating plainly. The shipped `portal-home.png` reads "1 device ·
 * 1 app": a workspace with ten apps is a signed-in account state that cannot be
 * photographed without an account that has those ten apps installed, and the
 * local registry carries six placeholders, so seeding could not produce them
 * either.
 *
 * What IS real: every app below — name, id, one-line description and icon — is
 * pulled from the live store API (`hub.ci.computer/api/store`, 492 apps), and
 * the palette is sampled from `portal-home.png` itself rather than guessed. So
 * the apps and the styling are the product's own; the arrangement is staged.
 *
 * Laid out at the capture's own CSS width (1600 landscape / 450 portrait) so
 * the device aperture scales it by exactly the factor a real plate would get,
 * and type lands at the same size as in the captured screens either side of it.
 */

/** Sampled from portal-home.png — see the capture, not a theme file. */
const C = {
  page: '#001218',
  topBar: '#020618',
  card: '#0A222E',
  panel: '#0B2430',
  border: 'rgba(64,155,155,0.18)',
  text: '#E8F2F4',
  muted: '#9BB4BB',
  link: '#4BB8C4',
  online: '#34D399',
  onlineBg: '#0D3A38',
  cta: 'linear-gradient(90deg, #0F717A 0%, #17A2A2 100%)',
};

export type WorkspaceApp = {id: string; name: string; icon: string};

/**
 * Ten apps, in the order they appear. Hermes, OpenClaw, Companion Memory,
 * Import Tools and Affine are the named five; Immich leads because the film
 * installs it two chapters earlier and it would be odd for it to vanish.
 */
export const WORKSPACE_APPS: WorkspaceApp[] = [
  {id: 'immich', name: 'Immich', icon: 'appicons/immich.png'},
  {id: 'ci-hermes', name: 'Hermes', icon: 'appicons/ci-hermes.png'},
  {id: 'openclaw', name: 'OpenClaw', icon: 'appicons/openclaw.png'},
  {id: 'ci-memory', name: 'Companion Memory', icon: 'appicons/ci-memory.png'},
  {id: 'ci-import-tools', name: 'Import Tools', icon: 'appicons/ci-import-tools.png'},
  {id: 'affine', name: 'Affine', icon: 'appicons/affine.png'},
  {id: 'home-assistant', name: 'Home Assistant', icon: 'appicons/home-assistant.png'},
  {id: 'jellyfin', name: 'Jellyfin', icon: 'appicons/jellyfin.png'},
  {id: 'joplin', name: 'Joplin Server', icon: 'appicons/joplin.png'},
  {id: 'langflow', name: 'Langflow', icon: 'appicons/langflow.png'},
];

const DEVICE = 'Living Room Server';

/** The host line under each app, as the real card renders it. */
const hostFor = (id: string) => `${id}-living-room-server-compan…`;

const AppCard: React.FC<{app: WorkspaceApp; s: number; compact?: boolean}> = ({
  app,
  s,
  compact,
}) => (
  <div
    style={{
      background: C.card,
      border: `${Math.max(1, s * 1)}px solid ${C.border}`,
      borderRadius: s * (compact ? 11 : 14),
      padding: s * (compact ? 10 : 16),
      display: 'flex',
      flexDirection: 'column',
      gap: s * (compact ? 7 : 10),
    }}
  >
    <div style={{display: 'flex', alignItems: 'center', gap: s * (compact ? 8 : 12)}}>
      <Img
        src={staticFile(app.icon)}
        style={{
          width: s * (compact ? 30 : 44),
          height: s * (compact ? 30 : 44),
          borderRadius: s * (compact ? 7 : 10),
          objectFit: 'cover',
          flexShrink: 0,
          background: '#fff',
        }}
      />
      <div style={{flex: 1, minWidth: 0}}>
        <div
          style={{
            fontSize: s * (compact ? 12 : 17),
            fontWeight: 700,
            color: C.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {app.name}
        </div>
        {!compact && (
          <div style={{fontSize: s * 12, color: C.muted, marginTop: s * 3}}>{DEVICE}</div>
        )}
      </div>
      {compact ? (
        <span
          style={{
            width: s * 7,
            height: s * 7,
            borderRadius: 999,
            background: C.online,
            display: 'block',
            flexShrink: 0,
          }}
        />
      ) : (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: s * 5,
          background: C.onlineBg,
          color: C.online,
          borderRadius: 999,
          padding: `${s * 4}px ${s * 9}px`,
          fontSize: s * 11,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: s * 6,
            height: s * 6,
            borderRadius: 999,
            background: C.online,
            display: 'block',
          }}
        />
        Online
      </div>
      )}
    </div>

    {!compact && (
      <div
        style={{
          fontSize: s * 11,
          color: C.link,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {hostFor(app.id)}
      </div>
    )}

    <div style={{display: 'flex', gap: s * 8}}>
      <div
        style={{
          flex: 1,
          background: C.cta,
          color: '#04222A',
          fontWeight: 700,
          fontSize: s * (compact ? 11 : 13),
          textAlign: 'center',
          borderRadius: s * (compact ? 6 : 8),
          padding: `${s * (compact ? 6 : 9)}px 0`,
        }}
      >
        Open
      </div>
      <div
        style={{
          width: s * (compact ? 26 : 36),
          borderRadius: s * (compact ? 6 : 8),
          border: `1px solid ${C.border}`,
          color: C.muted,
          fontSize: s * 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ⚙
      </div>
    </div>
  </div>
);

/**
 * @param width  design width in CSS px — 1600 landscape, 450 portrait, matching
 *               the viewports video-kit captures at.
 * @param height design height, so the screen fills the aperture exactly.
 */
export const WorkspaceScreen: React.FC<{
  width: number;
  height: number;
  isPortrait: boolean;
}> = ({width, height, isPortrait}) => {
  // One scalar drives every dimension, so the portrait build is the landscape
  // build at a different size rather than a second set of magic numbers.
  const s = isPortrait ? width / 450 : width / 1600;
  const apps = WORKSPACE_APPS;

  return (
    <div
      style={{
        width,
        height,
        background: C.page,
        fontFamily,
        color: C.text,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* top bar */}
      <div
        style={{
          height: s * (isPortrait ? 56 : 46),
          background: C.topBar,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${s * 18}px`,
          gap: s * 14,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: s * 8}}>
          <div
            style={{
              width: s * 22,
              height: s * 22,
              borderRadius: 999,
              background: 'radial-gradient(circle at 35% 35%, #7FE3E3, #0F717A 70%)',
            }}
          />
          <div style={{fontSize: s * 10, lineHeight: 1.05, color: '#8FD3D8', fontWeight: 600}}>
            COMPANION
            <br />
            INTELLIGENCE
          </div>
        </div>
        <div style={{flex: 1}} />
        {!isPortrait && (
          <div style={{display: 'flex', gap: s * 18, fontSize: s * 13, color: C.muted}}>
            <span style={{color: C.text}}>Home</span>
            <span>Store</span>
          </div>
        )}
        <div style={{flex: 1}} />
        <div style={{fontSize: s * 16, color: C.muted}}>{isPortrait ? '☰' : '◑'}</div>
      </div>

      {/* body */}
      <div
        style={{
          display: 'flex',
          gap: s * 20,
          padding: `${s * (isPortrait ? 22 : 26)}px ${s * (isPortrait ? 16 : 34)}px`,
        }}
      >
        <div style={{flex: 1, minWidth: 0}}>
          {/* title */}
          <div style={{display: 'flex', alignItems: 'center', gap: s * 14}}>
            <div
              style={{
                width: s * (isPortrait ? 52 : 44),
                height: s * (isPortrait ? 52 : 44),
                borderRadius: s * 12,
                background: C.panel,
                border: `1px solid ${C.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: s * 22,
                color: '#5FD5D5',
              }}
            >
              ▤
            </div>
            <div>
              <div
                style={{
                  fontSize: s * (isPortrait ? 27 : 26),
                  fontWeight: 700,
                  lineHeight: 1.05,
                  maxWidth: isPortrait ? s * 240 : undefined,
                }}
              >
                Companion Intelligence
              </div>
              <div style={{fontSize: s * 13, color: C.muted, marginTop: s * 4}}>
                1 device · {apps.length} apps
              </div>
            </div>
          </div>

          {/* search row */}
          <div style={{display: 'flex', gap: s * 10, marginTop: s * 16}}>
            <div
              style={{
                flex: 1,
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: s * 10,
                padding: `${s * 10}px ${s * 14}px`,
                fontSize: s * 13,
                color: C.muted,
              }}
            >
              ⌕&nbsp;&nbsp;Search apps, domains, or devices…
            </div>
            <div
              style={{
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: s * 10,
                padding: `${s * 10}px ${s * 14}px`,
                fontSize: s * 13,
                color: C.text,
                whiteSpace: 'nowrap',
              }}
            >
              All Apps ⌄
            </div>
          </div>

          {/* the grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${isPortrait ? 2 : 3}, 1fr)`,
              gap: s * (isPortrait ? 9 : 14),
              marginTop: s * 16,
            }}
          >
            {apps.map((a) => (
              <AppCard key={a.id} app={a} s={s} compact={isPortrait} />
            ))}
          </div>
        </div>

        {/* devices panel — landscape only, as the real layout stacks it below on
            mobile and the grid is what this beat is about */}
        {!isPortrait && (
          <div style={{width: s * 300, flexShrink: 0}}>
            <div
              style={{
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: s * 14,
                padding: s * 16,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: s * 10}}>
                <div style={{fontSize: s * 17, fontWeight: 700, flex: 1}}>Devices</div>
                <div
                  style={{
                    border: `1px solid ${C.border}`,
                    borderRadius: 999,
                    padding: `${s * 5}px ${s * 11}px`,
                    fontSize: s * 11,
                    color: C.text,
                  }}
                >
                  + Add Device
                </div>
              </div>

              <div
                style={{
                  marginTop: s * 14,
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: s * 12,
                  padding: s * 14,
                  display: 'flex',
                  gap: s * 12,
                }}
              >
                <div style={{flex: 1}}>
                  <div style={{fontSize: s * 14, fontWeight: 700}}>{DEVICE}</div>
                  <div
                    style={{
                      fontSize: s * 11,
                      color: C.online,
                      marginTop: s * 3,
                      display: 'flex',
                      alignItems: 'center',
                      gap: s * 5,
                    }}
                  >
                    <span
                      style={{
                        width: s * 6,
                        height: s * 6,
                        borderRadius: 999,
                        background: C.online,
                        display: 'block',
                      }}
                    />
                    Online
                  </div>
                  <div style={{fontSize: s * 10, color: C.muted, marginTop: s * 10}}>
                    Last seen: 6/10/2026, 7:20:58 PM
                  </div>
                </div>
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: s * 22, fontWeight: 700, color: '#5FD5D5'}}>
                    {apps.length}
                  </div>
                  <div style={{fontSize: s * 9, color: C.muted, letterSpacing: '0.1em'}}>
                    APPS
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
