import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "sage" | "ghost" | "danger";
  size?: "sm" | "lg";
  icon?: ReactNode;
  loading?: boolean;
  iconOnly?: boolean;
};

export function Button({ variant, size, icon, loading, iconOnly, className, children, disabled, ...rest }: ButtonProps) {
  const cls = ["btn", variant, size, iconOnly && "icon", className].filter(Boolean).join(" ");
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-label="Loading" />;
}

export function Progress({ value, tone, thick }: { value: number; tone?: "terracotta"; thick?: boolean }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={["progress", tone, thick && "thick"].filter(Boolean).join(" ")} role="progressbar" aria-valuenow={Math.round(pct)}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Meter({ value }: { value: number }) {
  const tone = value > 1 ? "over" : value > 0.92 ? "warn" : "";
  return (
    <div className={`meter ${tone}`} role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.min(1, value) * 100}%` }} />
    </div>
  );
}

export function Cover({ src, title, className }: { src?: string | null; title: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={["cover", className].filter(Boolean).join(" ")}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="fallback">{title}</div>
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: "48ch" }}>{children}</p>}
      {action}
    </div>
  );
}

export function Note({ tone = "warn", children }: { tone?: "warn" | "info" | "error" | "ok"; children: ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "info" ? Info : AlertTriangle;
  return (
    <div className={`note ${tone === "warn" ? "" : tone}`}>
      <Icon size={17} />
      <div>{children}</div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" iconOnly size="sm" onClick={onClose} aria-label="Close" icon={<X size={18} />} />
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

const ToastContext = createContext<(text: string, tone?: "info" | "error") => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PageHead({ eyebrow, title, lede, actions }: { eyebrow?: string; title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="titles">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </header>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: ReactNode }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={value === t.id ? "active" : ""}
          onClick={(e) => {
            onChange(t.id);
            e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SourceIcon({ kind, size = 14 }: { kind: "audible" | "podcast" | "local"; size?: number }) {
  if (kind === "audible")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M3 10.5c5.5-4.2 12.5-4.2 18 0" stroke="#d98a2b" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M6.5 13.6c3.4-2.6 7.6-2.6 11 0" stroke="#d98a2b" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M10 16.6c1.3-1 2.7-1 4 0" stroke="#d98a2b" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  return null;
}
