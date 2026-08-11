import {loadFont} from '@remotion/google-fonts/Manrope';

/**
 * Manrope is CI canon — `--font-sans` in `packages/tokens/src/globals.css`,
 * `MANROPE_STACK` in `@companionintelligence/tokens/manrope`, and the face
 * video-kit sets in `src/brand.mjs`.
 *
 * This film was previously set in Montserrat. That is the PRE-v0.3 brand:
 * video-kit's `brand.mjs` records it was "repainted 2026-08-05 from the pre-v0.3
 * teal/Montserrat palette". The graphics this film now matches
 * (`graphic-frames/import-tools-v2`) are Manrope, so staying on Montserrat left
 * the film on a superseded face and visibly off its own reference.
 *
 * DISPLAY WEIGHT 200 is deliberate and is why the weight list below is not the
 * tokens package's [400,500,600,700]: the vendored variable binary's `wght` axis
 * runs 200-800 with a named ExtraLight at exactly 200, and intro titles, feature
 * headings and outro CTAs are set in it. Clamping to the tokens list would
 * silently round all three up to 400.
 */
export const {fontFamily} = loadFont('normal', {
  weights: ['200', '400', '500', '600', '700'],
  subsets: ['latin'],
});

/** `--font-letter-spacing` / `MANROPE_LETTER_SPACING` from the tokens package. */
export const letterSpacing = '0.2pt';

/** `--font-word-spacing` / `MANROPE_WORD_SPACING`. */
export const wordSpacing = '0.4pt';
