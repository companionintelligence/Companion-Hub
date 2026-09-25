/**
 * Saves `blob` as a file named `filename` and returns where it landed, when that is known.
 *
 * The desktop webview drops `<a download>` clicks — nothing on the Rust side handles
 * downloads — so inside Tauri the bytes go to `save_download_command`, which writes them to
 * the user's Downloads folder and returns the path. A browser gets the usual object-URL
 * link, and the browser decides where the file goes (`null`).
 */
export async function saveBlobAsFile(filename: string, blob: Blob): Promise<string | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return invoke<string>('save_download_command', { filename, contents: Array.from(bytes) });
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  link.remove();

  // WebKit can cancel a download whose URL is revoked in the same task as the click.
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 0);

  return null;
}

/** Splits a saved path into its folder and file name, for either path separator. */
export function splitSavedPath(savedPath: string): { folder: string; file: string } {
  const separator = Math.max(savedPath.lastIndexOf('/'), savedPath.lastIndexOf('\\'));
  if (separator < 0) {
    return { folder: '', file: savedPath };
  }
  return { folder: savedPath.slice(0, separator) || savedPath.slice(0, 1), file: savedPath.slice(separator + 1) };
}
