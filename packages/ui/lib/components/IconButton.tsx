import { cn } from '../utils';
import type React from 'react';

type IconButtonProps = {
  ariaLabel: string;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
};

export const IconButton: React.FC<IconButtonProps> = ({ ariaLabel, title, onClick, disabled, className, children }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'inline-flex h-8 w-8 items-center justify-center rounded-md border text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 active:scale-95 disabled:opacity-60',
      className,
    )}>
    {children}
  </button>
);
