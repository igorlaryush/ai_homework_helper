import { cn } from '../utils';
import React, { forwardRef } from 'react';

type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ariaLabel: string;
  className?: string;
  children: React.ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ ariaLabel, className, children, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 active:scale-95 disabled:opacity-60',
        className,
      )}
      {...rest}>
      {children}
    </button>
  ),
);
IconButton.displayName = 'IconButton';
