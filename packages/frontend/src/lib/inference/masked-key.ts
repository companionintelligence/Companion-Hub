/** What the Hub sends for a stored key it won't show: a cloud provider key, or the vLLM key. */
export const MASKED_KEY = '••••••••';

/**
 * Whether a key field still holds the mask, so the key is the one the Hub has stored. Checked after
 * trimming, as every save and probe trims: a mask with a stray space must not go out as a key.
 */
export function isMaskedKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith('••');
}
