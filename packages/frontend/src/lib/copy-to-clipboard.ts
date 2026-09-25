import { toast } from 'sonner';

/**
 * Copy text to the clipboard, toasting ONLY on a confirmed successful write. The Clipboard API can
 * be unavailable (insecure context) or blocked by permission, in which case this stays silent
 * rather than falsely claim success. Single definition shared by every "copy" affordance so the
 * insecure-context / denied handling can never drift between call sites.
 */
export function copyToClipboard(text: string, successMsg: string): void {
  const clip = navigator.clipboard;
  if (!clip) {
    return;
  }
  clip.writeText(text).then(
    () => toast.success(successMsg),
    () => {
      /* clipboard write blocked — no false-positive toast */
    },
  );
}
