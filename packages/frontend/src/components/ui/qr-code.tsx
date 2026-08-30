/*
 * QrCode — the canonical CI QR primitive.
 *
 * The canonical version of this component lives in CI-Common as part of
 * `@companionintelligence/ui`. This is a local copy that deliberately mirrors
 * that API prop-for-prop, and should be deleted in favour of the package once
 * CI-Hub adopts `@companionintelligence/ui`. Keep any change here in sync with
 * CI-Common rather than forking the API.
 */
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { QRCodeSVG } from 'qrcode.react';
import { type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * The one place the CI design canon does not apply.
 *
 * Scanners expect dark modules on a light ground, so these two values are
 * theme-invariant constants rather than `--primary`/`--background` tokens: a QR
 * inverted for dark mode, or tinted teal, fails to decode on a large share of
 * phone cameras. CI teal is allowed on the frame, border and caption only —
 * never on the data modules or the plate behind them.
 */
const QR_PLATE_COLOR = '#ffffff';
const QR_MODULE_COLOR = '#0b0f19';

/* Quiet zone, in modules. Four is the spec minimum; cropping it costs decodes. */
const QR_MARGIN_MODULES = 4;

/* Mark occupies ~22% of the code's width — enough to read, small enough to recover. */
const QR_MARK_RATIO = 0.22;
const QR_MARK_SRC = '/logo.svg';

export interface QrCodeProps {
  /** The payload encoded into the code. */
  value: string;
  /**
   * The same payload as selectable text, rendered under the code.
   *
   * Required, not optional: a QR-only path dead-ends every user whose camera
   * will not focus, and there is no graceful degradation from a blurry square.
   */
  fallback: string;
  /** Rendered width/height of the code in px. */
  size?: number;
  /** Error-correction level. Forced to `H` whenever `mark` is set. */
  level?: 'L' | 'M' | 'Q' | 'H';
  /** Draw the CI mark in the centre, excavating the modules underneath. */
  mark?: boolean;
  /** Rendered above the code. */
  caption?: ReactNode;
  /** Hide the code and the fallback behind a blurred plate until asked for. */
  reveal?: boolean;
  /**
   * Drop the plate's padding and the printed fallback text/link entirely.
   *
   * Only for a screen where the QR sits next to its own obvious context (a
   * "Scan QR" disclosure the user just opened) and the fallback text would be
   * pure clutter. `fallback` stays a required prop even here — it is still
   * used for the `alt`/accessible name — this only controls what's painted.
   */
  bare?: boolean;
}

export const QrCode = ({ value, fallback, size = 200, level = 'M', mark = false, caption, reveal = false, bare = false }: QrCodeProps) => {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const plateId = useId();

  // A logo is pure occlusion: decoders treat the covered modules as unknown-position
  // errors, which roughly halves the usable error budget. `H` buys that back.
  const effectiveLevel = mark ? 'H' : level;
  const isHidden = reveal && !revealed;
  const markSize = Math.round(size * QR_MARK_RATIO);

  return (
    <div className="flex flex-col items-start gap-3">
      {caption ? <div className="text-sm text-muted-foreground">{caption}</div> : null}

      <div
        className={cn('relative inline-flex rounded-lg border-2 border-primary/40', bare ? 'p-0' : 'p-3')}
        style={{ backgroundColor: QR_PLATE_COLOR }}
      >
        <QRCodeSVG
          value={value}
          size={size}
          level={effectiveLevel}
          marginSize={QR_MARGIN_MODULES}
          bgColor={QR_PLATE_COLOR}
          fgColor={QR_MODULE_COLOR}
          title={t('COMMON_QR_CODE')}
          aria-label={fallback}
          className={cn('block h-auto max-w-full', isHidden && 'select-none blur-md')}
          imageSettings={
            mark
              ? {
                  src: QR_MARK_SRC,
                  height: markSize,
                  width: markSize,
                  excavate: true,
                }
              : undefined
          }
        />

        {isHidden ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-md">
            {/*
              No `aria-expanded`. This is not a disclosure widget: the button
              unmounts the moment the payload is revealed and a separate
              `COMMON_QR_HIDE_CODE` button takes its place, so the attribute could
              only ever be read as `false` — a permanent claim that the thing it
              controls is collapsed, made by a control that is only on screen while
              that happens to be true. `aria-controls` stays because it is still
              accurate: both buttons act on the plate below.
            */}
            <Button type="button" size="sm" intent="primary" aria-controls={plateId} onClick={() => setRevealed(true)}>
              {t('COMMON_QR_SHOW_CODE')}
            </Button>
          </div>
        ) : null}
      </div>

      {bare ? null : (
        <div id={plateId} className="w-full min-w-0">
          {isHidden ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{t('COMMON_QR_HIDDEN_HINT')}</p>
          ) : (
            <p className="min-w-0 break-all font-mono text-xs leading-relaxed text-foreground select-all">{fallback}</p>
          )}
        </div>
      )}

      {reveal && revealed ? (
        <Button type="button" size="sm" variant="ghost" aria-controls={plateId} onClick={() => setRevealed(false)}>
          {t('COMMON_QR_HIDE_CODE')}
        </Button>
      ) : null}
    </div>
  );
};
