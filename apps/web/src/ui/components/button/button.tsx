import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../cn';
import { buttonClass } from './button-class';

export type ButtonProps = {
  readonly variant?: 'primary' | 'secondary' | 'ghost';
  readonly children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({
  variant = 'primary',
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonClass(variant), className)}
      {...rest}
    >
      {children}
    </button>
  );
}
