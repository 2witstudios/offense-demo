import { appConfig } from '../../../app-config';
import { cn } from '../../cn';
import { brandMarkGeometry } from './brand-mark-geometry';

/**
 * Fills per variant: `primary` sits on the page in either scheme, `mono`
 * takes currentColor (the disc knocks out to the page), and `reverse` sits on
 * the stage panel.
 */
const brandMarkFills = {
  primary: { square: 'fill-accent', disc: 'fill-accent-ink' },
  mono: { square: 'fill-current', disc: 'fill-background' },
  reverse: { square: 'fill-stage-accent', disc: 'fill-surface-stage' },
} as const;

type BrandMarkVariant = keyof typeof brandMarkFills;

export type BrandMarkProps = {
  readonly size: number;
  readonly variant: BrandMarkVariant;
  readonly className?: string;
};

/** The product mark, decorative: the wordmark beside it carries the name. */
export function BrandMark({ size, variant, className }: BrandMarkProps) {
  const { size: drawing, cornerRadius, discRadius } = brandMarkGeometry;
  const fills = brandMarkFills[variant];
  return (
    <svg
      viewBox={`0 0 ${drawing} ${drawing}`}
      width={size}
      height={size}
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <rect
        width={drawing}
        height={drawing}
        rx={cornerRadius}
        className={fills.square}
      />
      <circle
        cx={drawing / 2}
        cy={drawing / 2}
        r={discRadius}
        className={fills.disc}
      />
    </svg>
  );
}

export type BrandWordmarkProps = {
  /** Classes for the name, e.g. to hide it at narrow widths. */
  readonly nameClassName?: string;
};

/** The mark beside the product name from `appConfig.brand`. */
export function BrandWordmark({ nameClassName }: BrandWordmarkProps) {
  return (
    <>
      <BrandMark size={34} variant="primary" className="size-shell-logo" />
      <span
        className={cn(
          'font-display text-xl leading-shell-brand font-semibold tracking-tight text-ink',
          nameClassName,
        )}
      >
        {appConfig.brand.displayName}
      </span>
    </>
  );
}
