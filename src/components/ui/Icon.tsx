import { component$, type SVGAttributes } from "@qwik.dev/core";

export type IconName =
  | "alert"
  | "arrow-left"
  | "bot"
  | "calendar"
  | "check"
  | "check-circle"
  | "chevron-down"
  | "clock"
  | "file"
  | "info"
  | "logout"
  | "message"
  | "more"
  | "paperclip"
  | "plus"
  | "printer"
  | "search"
  | "send"
  | "settings"
  | "smile"
  | "spark"
  | "user"
  | "x";

interface IconProps extends SVGAttributes<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export const Icon = component$<IconProps>(({ name, size = 20, ...props }) => {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {name === "message" && (
        <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
      )}
      {name === "calendar" && (
        <>
          <rect height="18" rx="2" width="18" x="3" y="4" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </>
      )}
      {name === "file" && (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6M8 13h8M8 17h6" />
        </>
      )}
      {name === "settings" && (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </>
      )}
      {name === "arrow-left" && <path d="m15 18-6-6 6-6" />}
      {name === "info" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </>
      )}
      {name === "bot" && (
        <>
          <rect height="13" rx="3" width="18" x="3" y="8" />
          <path d="M12 4v4M9 13h.01M15 13h.01M8 17h8" />
        </>
      )}
      {name === "send" && <path d="m22 2-7 20-4-9-9-4ZM22 2 11 13" />}
      {name === "plus" && <path d="M12 5v14M5 12h14" />}
      {name === "printer" && (
        <>
          <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <path d="M6 14h12v7H6zM18 12h.01" />
        </>
      )}
      {name === "more" && (
        <>
          <circle cx="5" cy="12" fill="currentColor" r="1" stroke="none" />
          <circle cx="12" cy="12" fill="currentColor" r="1" stroke="none" />
          <circle cx="19" cy="12" fill="currentColor" r="1" stroke="none" />
        </>
      )}
      {name === "smile" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
        </>
      )}
      {name === "paperclip" && (
        <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
      )}
      {name === "spark" && <path d="m13 2-2 7H4l6 4-2 9 7-10h5l-5-3 2-7Z" />}
      {name === "x" && <path d="M18 6 6 18M6 6l12 12" />}
      {name === "clock" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      )}
      {name === "user" && (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </>
      )}
      {name === "check" && <path d="m5 12 4 4L19 6" />}
      {name === "check-circle" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 2.5 2.5L16 9" />
        </>
      )}
      {name === "alert" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 17h.01" />
        </>
      )}
      {name === "chevron-down" && <path d="m6 9 6 6 6-6" />}
      {name === "logout" && (
        <>
          <path d="M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
        </>
      )}
    </svg>
  );
});
