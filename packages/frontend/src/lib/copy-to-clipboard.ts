import { toast } from 'sonner';

/**
 * Copy text to the clipboard, toasting ONLY on a confirmed successful write. The Clipboard API can
 * be unavailable (insecure context) or blocked by permission, in which case this stays silent
 * rather than falsely claim success. Single definition shared by every "copy" affordance so the
 * insecure-context / denied handling can never drift between call sites; {@link copyOrSelect} is
 * the variant for text the user must be able to take away even then.
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

/** What {@link copyOrSelect} managed: the text is on the clipboard, or it is only selected, for the user to copy. */
export type CopyOrSelectOutcome = 'copied' | 'selected';

/** Select everything in `element`, as a triple-click would, so the user can copy it with the keyboard. */
function selectContents(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Copy `text`, or failing that select `element` (which shows exactly that text) so the user can copy
 * it by hand. For a command to run on the host, where staying silent like {@link copyToClipboard}
 * leaves the user nothing: the Hub is often opened over plain http on the LAN (`http://<host>:5002`),
 * which is not a secure context, so `navigator.clipboard` is undefined there; it can also be denied.
 *
 * Then the text is selected, and the browser's own copy command is tried on that selection, which
 * still works in an insecure context in response to a click. It runs before any `await` when the API
 * is missing, so it is still inside the click's user activation. When it fails too the selection
 * stays, and `selected` tells the caller to say which keys to press.
 */
export async function copyOrSelect(text: string, element: HTMLElement | null): Promise<CopyOrSelectOutcome> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch {
    // Denied or unavailable: fall through to the selection.
  }
  if (!element) return 'selected';
  selectContents(element);
  try {
    if (typeof document.execCommand === 'function' && document.execCommand('copy')) {
      return 'copied';
    }
  } catch {
    // Some browsers throw rather than return false; the selection is still there to copy by hand.
  }
  return 'selected';
}
