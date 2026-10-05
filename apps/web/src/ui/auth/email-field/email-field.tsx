import type { ReactNode } from 'react';
import { fieldClass } from './field-class';

export type EmailFieldProps = {
  readonly id: string;
  readonly label: string;
  /** The submit control that sits beside the input. */
  readonly action: ReactNode;
  /** `username webauthn` lets the browser offer a saved passkey. */
  readonly autoComplete: 'username webauthn' | 'email';
  /** Controlled value; omit for a plain server-posted form. */
  readonly value?: string;
  readonly typeEmail?: (email: string) => void;
  readonly disabled?: boolean;
  /** Id of the notice that explains why the address was refused. */
  readonly errorId?: string;
};

/** Email input with its label and submit control on one row. */
export function EmailField({
  id,
  label,
  action,
  autoComplete,
  value,
  typeEmail,
  disabled = false,
  errorId,
}: EmailFieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldClass.label}>
        {label}
      </label>
      <div className={fieldClass.row}>
        <input
          id={id}
          name="email"
          type="email"
          required
          autoComplete={autoComplete}
          placeholder="you@school.edu"
          value={value}
          onChange={
            typeEmail && ((event) => typeEmail(event.currentTarget.value))
          }
          disabled={disabled}
          aria-invalid={errorId === undefined ? undefined : true}
          aria-describedby={errorId}
          className={fieldClass.input}
        />
        {action}
      </div>
    </div>
  );
}
