import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * The box the Hub's other notices already draw by hand (`TunnelStatusBanner`, the pool setup card,
 * the queued-installs note): a tinted border and background in the variant's colour, the icon and
 * the heading in that colour, and the text in the page's colours. The variant sets
 * `--alert-accent`, which `AlertIcon` and `AlertHeading` read, so a nested part never needs to be
 * told which variant it sits in.
 *
 * The `alert*` names stay on the elements so existing selectors still find them; no stylesheet
 * defines them, and all the styling is the Tailwind classes here.
 */
const alertVariants = cva(
  [
    'alert relative flex w-full items-start gap-2.5 rounded-lg border px-4 py-3 text-sm text-foreground shadow-sm',
    // The heading's colour. On the light theme the red and the blue are too light for 14px text on
    // their own tint (3.3:1 and 3.4:1), so the heading takes three quarters accent and one quarter text
    // colour there (4.8:1 or better). On the dark theme every accent reads on its own.
    '[--alert-heading:color-mix(in_srgb,var(--alert-accent)_75%,var(--color-foreground))] dark:[--alert-heading:var(--alert-accent)]',
  ],
  {
    variants: {
      variant: {
        default: 'border-border/60 bg-muted/40 [--alert-accent:var(--color-foreground)]',
        success: 'alert-success border-success/30 bg-success/10 [--alert-accent:var(--color-success)]',
        info: 'alert-info border-info/30 bg-info/10 [--alert-accent:var(--color-info)]',
        warning: 'alert-warning border-warning/30 bg-warning/10 [--alert-accent:var(--color-warning)]',
        danger: 'alert-danger border-destructive/30 bg-destructive/10 [--alert-accent:var(--color-destructive)]',
      },
      dismissible: {
        // Room for a close button placed `absolute right-3 top-3` in the box.
        true: 'alert-dismissible pr-10',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      dismissible: false,
    },
  },
);

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

const Alert = ({ className, dismissible, variant, ...props }: AlertProps) => (
  <div className={cn(alertVariants({ variant, dismissible }), className)} role="alert" {...props}>
    {props.children}
  </div>
);
Alert.displayName = 'Alert';

const AlertHeading = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h4 className={cn('alert-heading font-semibold leading-relaxed text-[color:var(--alert-heading)]', className)} {...props} />
);
AlertHeading.displayName = 'AlertHeading';

/** The page's own text colour, muted when a heading above it carries the message, as in `TunnelStatusBanner`. */
const AlertDescription = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('alert-description leading-relaxed [.alert-heading+&]:text-muted-foreground', className)} {...props} />
);
AlertDescription.displayName = 'AlertDescription';

/** Sizes the icon inside it to the text, as `TunnelStatusBanner` does, and colours it with the variant. */
const AlertIcon = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('alert-icon mt-0.5 shrink-0 text-[color:var(--alert-accent)] [&>svg]:h-4 [&>svg]:w-4', className)} {...props}>
    {props.children}
  </div>
);
AlertIcon.displayName = 'AlertIcon';

export { Alert, AlertHeading, AlertDescription, AlertIcon };
