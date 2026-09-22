/** Grouped-list row widgets, shared by both interfaces. */
import type { ReactNode } from 'react';
import * as Icon from './icons';


export function Row({
  label,
  value,
  onClick,
  children,
}: {
  label: string;
  value?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`row${onClick ? ' tappable' : ''}`} onClick={onClick}>
      <span className="row-label">{label}</span>
      <span className="row-trail">
        {value && <span className="row-value">{value}</span>}
        {children}
        {onClick && <Icon.ChevronRight />}
      </span>
    </Tag>
  );
}

export function SliderRow({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="row slider">
      <span className="row-label">
        {label}
        <span className="row-value">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <span className={`switch${disabled ? ' off' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span />
      </span>
    </label>
  );
}

export function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | number;
  options: [string | number, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <span className="row-trail">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
        <Icon.ChevronRight />
      </span>
    </label>
  );
}
