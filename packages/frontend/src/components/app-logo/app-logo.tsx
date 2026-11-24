import clsx from 'clsx';
import { useId, useState } from 'react';
import type React from 'react';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import './app-logo.css';

/** The squircle the app tiles use. */
const SQUIRCLE_PATH = 'M-1 100C0 0 0 0 100 0S200 0 200 100 200 200 100 200 0 200 0 100';

/** The first letter of a name, for an app with no image of its own. */
export function appMonogramLetter(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : '';
}

export const AppLogo: React.FC<{
  urn?: string;
  url?: string;
  /** Pixels, or a CSS length such as `100%` to fill a box the caller sizes. */
  size?: number | string;
  className?: string;
  alt?: string;
  /**
   * The name to take a letter from when there is no image. Defaults to `alt`. An app made on this Hub
   * (a custom app, a port expose) and a link without an icon have no image, and the browser's own
   * broken-image glyph stood in for one.
   */
  name?: string;
  /** `rounded` matches the store app page's header logo; the tiles use the squircle. */
  shape?: 'squircle' | 'rounded';
  placeholder?: boolean;
}> = ({ urn, url, size = 80, className = '', alt = '', name, shape = 'squircle' }) => {
  const src = url || (urn ? getMarketplaceAppImageUrl(urn) : '');
  const maskId = useId();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const letter = appMonogramLetter(name ?? alt);
  const failed = !src || failedSrc === src;
  const showMonogram = failed && letter !== '';

  return (
    <div aria-description={alt} className={clsx(className)} style={{ width: size, height: size, minWidth: size }}>
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: Svg has no alt attibute */}
      <svg width={size} height={size} viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          {shape === 'rounded' ? (
            <rect width="200" height="200" rx="14" fill="white" />
          ) : (
            <path fillRule="evenodd" clipRule="evenodd" d={SQUIRCLE_PATH} fill="white" />
          )}
        </mask>
        {showMonogram ? (
          <g mask={`url(#${maskId})`} data-testid="app-logo-monogram">
            <rect width="200" height="200" className="fill-primary/20" />
            <text x="100" y="104" textAnchor="middle" dominantBaseline="central" fontSize="92" fontWeight="600" className="fill-primary font-sans">
              {letter}
            </text>
          </g>
        ) : (
          <image
            className="logo-image"
            href={failed ? '/app-not-found.jpg' : src}
            mask={`url(#${maskId})`}
            width="200"
            height="200"
            onError={() => setFailedSrc(src)}
          />
        )}
      </svg>
    </div>
  );
};
