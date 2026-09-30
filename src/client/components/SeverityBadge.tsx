import type { Severity } from "../../shared/types";
import { SEVERITY_LABEL } from "../format";

// Each level has its own shape as well as a text label, so severity is never
// conveyed by colour alone.
function Icon({ severity }: { severity: Severity }) {
  const common = {
    viewBox: "0 0 12 12",
    "aria-hidden": true,
    focusable: false
  } as const;
  switch (severity) {
    case "critical":
      return (
        <svg {...common}>
          <path d="M6 0.5 11.5 6 6 11.5 0.5 6Z" fill="currentColor" />
        </svg>
      );
    case "high":
      return (
        <svg {...common}>
          <path d="M6 1 11.5 11H0.5Z" fill="currentColor" />
        </svg>
      );
    case "medium":
      return (
        <svg {...common}>
          <rect
            x="1.5"
            y="1.5"
            width="9"
            height="9"
            rx="1"
            fill="currentColor"
          />
        </svg>
      );
    case "low":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle
            cx="6"
            cy="6"
            r="4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
        </svg>
      );
  }
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`sev sev-${severity}`}>
      <Icon severity={severity} />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}
