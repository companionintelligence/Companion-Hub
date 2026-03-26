import { WindowTitlebar } from "tauri-controls";

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

export function Titlebar() {
  if (!isTauri) return null;

  return (
    <WindowTitlebar
      controlsOrder="platform"
      className="h-10 bg-background border-b select-none"
      windowControlsProps={{
        className: "flex items-center",
      }}
    >
      <div className="flex items-center gap-2 px-3 flex-1" data-tauri-drag-region>
        <img src="/icons/favicon-96x96.png" alt="CI Hub" className="w-5 h-5" />
        <span className="text-sm font-medium text-foreground">Companion Hub</span>
      </div>
    </WindowTitlebar>
  );
}
