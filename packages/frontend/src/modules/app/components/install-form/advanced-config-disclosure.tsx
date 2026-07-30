import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface IProps {
  children: React.ReactNode;
  /** Rendered open with no toggle chrome at all — used when the operator's global Advanced Mode
   *  setting already opts them into seeing everything, matching the pre-existing behaviour. */
  alwaysOpen?: boolean;
  className?: string;
}

/**
 * Collapsed-by-default "Advanced Configuration" section for less-common install fields. There was
 * no existing disclosure/accordion primitive in the UI kit, so this is a small toggle built from
 * the existing Button component rather than a new formal primitive (see task instructions).
 */
export const AdvancedConfigDisclosure: React.FC<IProps> = ({ children, alwaysOpen, className }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const contentId = useId();

  if (alwaysOpen) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={cn('mb-3 rounded-md border border-border/60', className)}>
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-between rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/40"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{t('APP_INSTALL_FORM_ADVANCED_CONFIGURATION')}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div id={contentId} className="border-t border-border/60 p-3 pt-3">
          {children}
        </div>
      )}
    </div>
  );
};
