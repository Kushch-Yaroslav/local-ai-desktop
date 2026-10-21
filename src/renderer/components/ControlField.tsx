import type { ReactNode } from 'react';
import { ControlHelp } from './ControlHelp';

/** A control label and its help stay together above the control at every width. */
export function ControlField({ label, help, children, className = '', status }: {
  label: string;
  help: ReactNode;
  children: ReactNode;
  className?: string;
  status?: ReactNode;
}) {
  return <div className={`control-help-field control-field ${className}`.trim()}>
    <div className="control-label-row">
      <span className="control-field-label">{label}{status}</span>
      <ControlHelp label={label}>{help}</ControlHelp>
    </div>
    {children}
  </div>;
}
