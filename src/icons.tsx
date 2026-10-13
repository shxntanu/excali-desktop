export type IconName =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "file"
  | "sidebar"
  | "close"
  | "folder"
  | "folderPlus"
  | "pencil"
  | "plus"
  | "play"
  | "previous"
  | "next"
  | "laser"
  | "keyboard"
  | "skip"
  | "slides"
  | "up"
  | "down"
  | "frame";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(name === "new" || name === "file" || name === "saveAs") && (
        <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      )}
      {(name === "new" || name === "file") && (
        <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      )}
      {name === "new" && <path d="M12 11v6M9 14h6" />}
      {name === "saveAs" && (
        <path d="M11.5 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v5m-5 6h7m-3-3 3 3-3 3" />
      )}
      {name === "open" && (
        <path d="m5 19 2.757-7.351a1 1 0 0 1 .936-.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211A2 2 0 0 1 19.026 19H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2" />
      )}
      {name === "save" && (
        <>
          <path d="M6 4h10l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
          <circle cx="12" cy="14" r="2" />
          <path d="M14 4v4H8V4" />
        </>
      )}
      {name === "sidebar" && (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 4v16" />
        </>
      )}
      {name === "close" && <path d="M18 6 6 18M6 6l12 12" />}
      {(name === "folder" || name === "folderPlus") && (
        <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
      )}
      {name === "folderPlus" && <path d="M12 10v6M9 13h6" />}
      {name === "pencil" && (
        <path d="M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4M13.5 6.5l4 4" />
      )}
      {name === "plus" && <path d="M12 5v14M5 12h14" />}
      {name === "play" && <path d="M7 4v16l13-8z" />}
      {name === "previous" && <path d="m15 6-6 6 6 6" />}
      {name === "next" && <path d="m9 6 6 6-6 6" />}
      {name === "up" && <path d="m6 15 6-6 6 6" />}
      {name === "down" && <path d="m6 9 6 6 6-6" />}
      {name === "laser" && (
        <>
          <circle cx="17" cy="7" r="2.5" />
          <path d="M15 9 4 20M19.5 4.5l1-1M21 7h1.5M17 3V1.5" />
        </>
      )}
      {name === "keyboard" && (
        <>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
        </>
      )}
      {name === "skip" && (
        <>
          <path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" />
          <path d="M16.681 16.673A8.717 8.717 0 0 1 12 18c-3.6 0-6.6-2-9-6 1.272-2.12 2.712-3.678 4.32-4.674m2.86-1.146A9.055 9.055 0 0 1 12 6c3.6 0 6.6 2 9 6-.666 1.11-1.379 2.067-2.138 2.87M3 3l18 18" />
        </>
      )}
      {name === "slides" && (
        <>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M12 16v4M8 20h8" />
        </>
      )}
      {name === "frame" && <path d="M4 7h16M4 17h16M7 4v16M17 4v16" />}
    </svg>
  );
}
