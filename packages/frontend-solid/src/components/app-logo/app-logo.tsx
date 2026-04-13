import { cn } from '@/lib/utils';
import { createUniqueId } from 'solid-js';

interface AppLogoProps {
  urn?: string;
  url?: string;
  size?: number;
  class?: string;
  alt?: string;
}

export function AppLogo(props: AppLogoProps) {
  const size = () => props.size ?? 80;
  const maskId = createUniqueId();
  const logoUrl = () => props.urn ? `/api/marketplace/apps/${props.urn}/image` : '/app-not-found.jpg';

  return (
    <div class={cn('drop-shadow', props.class)} style={{ width: `${size()}px`, height: `${size()}px`, "min-width": `${size()}px` }}>
      <svg width={size()} height={size()} viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={props.alt || 'App logo'}>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M-1 100C0 0 0 0 100 0S200 0 200 100 200 200 100 200 0 200 0 100" fill="white" />
        </mask>
        <image href={props.url || logoUrl()} mask={`url(#${maskId})`} width="200" height="200" />
      </svg>
    </div>
  );
}
