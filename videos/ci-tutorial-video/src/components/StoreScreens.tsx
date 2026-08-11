import React from 'react';
import {Img, staticFile} from 'remotion';
import {fontFamily} from '../brand/fonts';

/**
 * Composed Hub App Store screens: the CI Marketplace category (cut-10), the
 * Immich detail page (cut-11) and its installing state (cut-13).
 *
 * COMPOSED, NOT CAPTURED — and each for a reason that a capture cannot solve:
 *  - cut-10 must OMIT two apps. You cannot remove a row from a photograph.
 *  - cut-11 must show the app's real store listing. The captured page shows a
 *    two-line summary and an empty 0.0★ rating; the fuller copy, the feature
 *    list and the screenshot all live in CI-Marketplace and were never on that
 *    page to be photographed.
 *  - cut-13 must show an installing state, which only exists mid-install.
 *
 * Every string and image here is read from CI-Marketplace (`apps/<id>/config.json`
 * and `apps/<id>/metadata/`), not written for the film. The palette is sampled
 * from the captured Hub screens so a composed screen and a photographed one can
 * sit in the same cut sequence without announcing which is which.
 */

const C = {
  page: '#0A1520',
  panel: '#0E1E2A',
  card: '#12222E',
  border: 'rgba(64,155,155,0.16)',
  text: '#E8F2F4',
  muted: '#93AAB2',
  dim: '#6E858D',
  teal: '#5FD5D5',
  free: '#7FE3C6',
  cta: 'linear-gradient(90deg, #0F717A 0%, #17A2A2 100%)',
  install: '#22C55E',
};

export type StoreApp = {id: string; name: string; short: string; icon: string};

/**
 * The CI Marketplace grid, WITHOUT Hermes and OpenClaw WebCLI — both are in the
 * captured page and are dropped here by direction.
 */
export const CI_APPS: StoreApp[] = [
  {id: 'ci-earth', name: 'Companion Earth', short: 'Pinpoint, scrapbook, and explore localized media across an evolving 3D globe', icon: 'appicons/ci-earth.png'},
  {id: 'ci-import-tools', name: 'Import Tools', short: 'Securely migrate files, social accounts, and cloud histories into your localized ecosystem', icon: 'appicons/ci-import-tools.png'},
  {id: 'ci-just-in-case', name: 'Just In Case', short: 'An offline, LLM-powered survival and preparedness engine when internet goes dark', icon: 'appicons/ci-just-in-case.png'},
  {id: 'ci-local-bench', name: 'Local Bench', short: 'Benchmark LLM performance directly on your local hardware to validate inference', icon: 'appicons/ci-local-bench.png'},
  {id: 'ci-photo-time-machine', name: 'Photo Time Machine', short: 'Organize and explore visual history as fully rendered, locally hosted memories', icon: 'appicons/ci-photo-time-machine.png'},
  {id: 'ci-spatial-companion-webxr', name: 'Spatial Companion', short: 'Talk to a 3D companion avatar in your space, powered by your local models', icon: 'appicons/ci-spatial-companion-webxr.png'},
  {id: 'ci-spellbook', name: 'Spellbook', short: 'Supercharge your local AI with structured prompts and reusable workflow templates', icon: 'appicons/ci-spellbook.png'},
  {id: 'ci-static-containter-builder', name: 'Static Container Builder', short: 'Build and deploy isolated static containers securely to your local hub', icon: 'appicons/ci-static-containter-builder.png'},
  {id: 'ci-tools-cache-mounts', name: 'Tools Cache Mount', short: 'Accelerated execution via optimized local caching layers for your toolchain', icon: 'appicons/ci-tools-cache-mounts.png'},
  {id: 'ci-webxr-time-machine', name: 'Spatial Time Machine', short: 'An immersive interface that lets you explore spatial footprints and memories', icon: 'appicons/ci-webxr-time-machine.png'},
];

const CATEGORIES = [
  'All', 'Alternatives', 'Featured', 'AI', 'Automation', 'Books', 'Data',
  'Development', 'Finance', 'Gaming', 'Media', 'Music', 'Network',
  'Photography', 'Security', 'Social', 'Utilities',
];

const Chrome: React.FC<{s: number; children: React.ReactNode}> = ({s, children}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: s * 22,
      height: s * 40,
      background: '#050F18',
      borderBottom: `1px solid ${C.border}`,
      fontSize: s * 12,
      color: C.muted,
    }}
  >
    {children}
  </div>
);

const Sidebar: React.FC<{s: number; search: React.ReactNode}> = ({s, search}) => (
  <div style={{width: s * 210, flexShrink: 0}}>
    {search}
    <div style={{marginTop: s * 12}}>
      {CATEGORIES.map((c, i) => (
        <div
          key={c}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: s * 10,
            padding: `${s * 7}px ${s * 12}px`,
            borderRadius: s * 8,
            background: i === 0 ? C.card : 'transparent',
            color: i === 0 ? C.text : C.muted,
            fontSize: s * 12,
            fontWeight: i === 0 ? 600 : 400,
          }}
        >
          <span style={{opacity: 0.7}}>▫</span>
          {c}
        </div>
      ))}
    </div>
  </div>
);

/* ------------------------------------------------------------------ cut-10 */
export const StoreCategoryScreen: React.FC<{
  width: number;
  height: number;
  isPortrait: boolean;
  /** Text currently in the search box. */
  search: string;
  caret: boolean;
}> = ({width, height, isPortrait, search, caret}) => {
  const s = isPortrait ? width / 450 : width / 1600;
  const cols = isPortrait ? 1 : 4;

  const searchBox = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: s * 8,
        background: C.card,
        border: `1px solid ${search ? 'rgba(130,252,252,0.55)' : C.border}`,
        borderRadius: s * 9,
        padding: `${s * 9}px ${s * 12}px`,
        fontSize: s * 12,
        color: search ? C.text : C.dim,
        boxShadow: search ? `0 0 ${s * 14}px rgba(130,252,252,0.18)` : undefined,
      }}
    >
      <span>⌕</span>
      <span style={{whiteSpace: 'nowrap', overflow: 'hidden'}}>
        {search || 'Search apps…'}
      </span>
      {caret && (
        <span
          style={{
            width: Math.max(1, s * 1.4),
            height: s * 14,
            background: C.text,
            display: 'inline-block',
          }}
        />
      )}
    </div>
  );

  return (
    <div style={{width, height, background: C.page, fontFamily, color: C.text, overflow: 'hidden'}}>
      <Chrome s={s}>
        <span>⌂ Home</span>
        <span style={{color: C.text, background: C.card, padding: `${s * 4}px ${s * 10}px`, borderRadius: 999}}>
          ⬓ App Store
        </span>
        <span>⚡ Resource Monitor</span>
      </Chrome>

      <div style={{display: 'flex', gap: s * 16, padding: s * 16}}>
        {!isPortrait && <Sidebar s={s} search={searchBox} />}
        <div style={{flex: 1, minWidth: 0}}>
          {isPortrait && <div style={{marginBottom: s * 12}}>{searchBox}</div>}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: s * 12,
              fontSize: s * 13,
              color: C.text,
              fontWeight: 600,
            }}
          >
            ▦&nbsp;&nbsp;CI Marketplace
          </div>
          <div style={{display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: s * 12}}>
            {CI_APPS.map((a) => (
              <div
                key={a.id}
                style={{
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: s * 12,
                  padding: s * 12,
                  minHeight: s * 118,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{display: 'flex', alignItems: 'flex-start'}}>
                  <Img
                    src={staticFile(a.icon)}
                    style={{width: s * 34, height: s * 34, borderRadius: s * 8, objectFit: 'cover'}}
                  />
                  <div style={{flex: 1}} />
                  <div style={{fontSize: s * 10, color: C.free}}>Free</div>
                </div>
                <div style={{fontSize: s * 13, fontWeight: 700, marginTop: s * 10}}>{a.name}</div>
                <div
                  style={{
                    fontSize: s * 10.5,
                    color: C.muted,
                    lineHeight: 1.35,
                    marginTop: s * 4,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {a.short}
                </div>
                <div style={{flex: 1}} />
                <div style={{textAlign: 'right', color: C.muted, fontSize: s * 12}}>⤓</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------- cut-11 and cut-13 */

/** Immich, as CI-Marketplace describes it. Nothing here was written for the film. */
const IMMICH = {
  name: 'Immich',
  author: 'Immich',
  short: 'Self-hosted photo and video management solution',
  description:
    'A self-hosted photo and video management platform for backing up, organizing, and browsing personal media libraries. Immich allows users to store and manage photos and videos on their own server, providing tools to search, organize, and view media while maintaining control over their data.',
  features: [
    'Self-hosted media backup — store and manage photos and videos on your own server infrastructure',
    'Media browsing and organization — navigate and organize collections through a web interface',
    'Search and discovery tools — locate photos and videos within your library',
    'Mobile applications — iOS and Android apps with automatic background backup',
    'Multi-user support — separate libraries and shared albums per household member',
  ],
  info: [
    ['Provider', 'Immich'],
    ['Categories', 'Data, Featured, Media, Photography'],
    ['Version', 'release'],
    ['Download Size', '~203 MB'],
    ['Architectures', 'arm64, amd64'],
    ['Min Hub Version', 'v4.5.0'],
    ['Website', 'immich.app'],
    ['Source code', 'github.com/immich-app/immich'],
  ] as [string, string][],
};

export const AppDetailScreen: React.FC<{
  width: number;
  height: number;
  isPortrait: boolean;
  /** 'idle' shows Install; 'installing' shows the progress state (cut-13). */
  state: 'idle' | 'installing';
  /** 0..1, only used when installing. */
  progress?: number;
}> = ({width, height, isPortrait, state, progress = 0}) => {
  const s = isPortrait ? width / 450 : width / 1600;
  const pct = Math.round(progress * 100);

  return (
    <div style={{width, height, background: C.page, fontFamily, color: C.text, overflow: 'hidden'}}>
      <Chrome s={s}>
        <span>⌂ Home</span>
        <span style={{color: C.text, background: C.card, padding: `${s * 4}px ${s * 10}px`, borderRadius: 999}}>
          ⬓ App Store
        </span>
        <span>⚡ Resource Monitor</span>
      </Chrome>

      <div style={{display: 'flex', gap: s * 20, padding: s * 18}}>
        <div style={{flex: 1, minWidth: 0}}>
          {/* header */}
          <div style={{display: 'flex', gap: s * 16, alignItems: 'flex-start'}}>
            <Img
              src={staticFile('appicons/immich.png')}
              style={{width: s * 78, height: s * 78, borderRadius: s * 16, objectFit: 'cover'}}
            />
            <div style={{flex: 1, minWidth: 0}}>
              <div style={{fontSize: s * 30, fontWeight: 700, lineHeight: 1.05}}>{IMMICH.name}</div>
              <div style={{fontSize: s * 12, color: C.muted, marginTop: s * 3}}>{IMMICH.author}</div>
              <div style={{fontSize: s * 11, color: C.muted, marginTop: s * 8}}>
                Free · Data, Photography
              </div>

              {state === 'idle' ? (
                <div
                  style={{
                    marginTop: s * 12,
                    display: 'inline-block',
                    background: C.install,
                    color: '#052014',
                    fontWeight: 700,
                    fontSize: s * 13,
                    borderRadius: s * 8,
                    padding: `${s * 9}px ${s * 34}px`,
                  }}
                >
                  Install
                </div>
              ) : (
                <div style={{marginTop: s * 12, maxWidth: s * 320}}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: s * 8,
                      fontSize: s * 12,
                      color: C.teal,
                      fontWeight: 600,
                    }}
                  >
                    <span
                      style={{
                        width: s * 9,
                        height: s * 9,
                        borderRadius: 999,
                        background: C.teal,
                        display: 'block',
                      }}
                    />
                    Installing… {pct}%
                  </div>
                  <div
                    style={{
                      marginTop: s * 7,
                      height: s * 7,
                      borderRadius: 999,
                      background: 'rgba(95,213,213,0.16)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: C.cta,
                        borderRadius: 999,
                      }}
                    />
                  </div>
                  <div style={{fontSize: s * 10.5, color: C.muted, marginTop: s * 6}}>
                    {pct < 35
                      ? 'Pulling container images…'
                      : pct < 70
                        ? 'Extracting layers…'
                        : pct < 95
                          ? 'Starting services…'
                          : 'Finishing up…'}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* about */}
          <div style={{marginTop: s * 20, fontSize: s * 15, fontWeight: 700}}>About this app</div>
          <div style={{marginTop: s * 8, fontSize: s * 12, lineHeight: 1.55, color: C.muted}}>
            {IMMICH.description}
          </div>

          <div style={{marginTop: s * 16, fontSize: s * 13, fontWeight: 700}}>Features</div>
          <div style={{marginTop: s * 8}}>
            {IMMICH.features.slice(0, isPortrait ? 3 : 5).map((f) => (
              <div
                key={f}
                style={{
                  display: 'flex',
                  gap: s * 9,
                  fontSize: s * 11.5,
                  color: C.muted,
                  lineHeight: 1.5,
                  marginBottom: s * 6,
                }}
              >
                <span style={{color: C.teal}}>✓</span>
                <span>{f}</span>
              </div>
            ))}
          </div>

          {!isPortrait && (
            <Img
              src={staticFile('immich-shot.jpg')}
              style={{
                marginTop: s * 14,
                width: '100%',
                maxWidth: s * 620,
                borderRadius: s * 10,
                border: `1px solid ${C.border}`,
                display: 'block',
              }}
            />
          )}
        </div>

        {!isPortrait && (
          <div style={{width: s * 300, flexShrink: 0}}>
            <div
              style={{
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: s * 12,
                padding: s * 14,
              }}
            >
              <div style={{fontSize: s * 14, fontWeight: 700, marginBottom: s * 10}}>
                Information
              </div>
              {IMMICH.info.map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: s * 12,
                    padding: `${s * 7}px 0`,
                    borderTop: `1px solid ${C.border}`,
                    fontSize: s * 10.5,
                  }}
                >
                  <span style={{color: C.muted, whiteSpace: 'nowrap'}}>{k}</span>
                  <span style={{textAlign: 'right', color: C.text}}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
