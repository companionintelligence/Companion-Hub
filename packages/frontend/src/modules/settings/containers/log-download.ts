import { saveBlobAsFile } from '@/lib/save-file';

export function getFilenameFromContentDisposition(header: string | null, fallbackFilename: string) {
  if (!header) {
    return fallbackFilename;
  }

  const encodedMatch = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return encodedMatch[1].trim().replace(/^"|"$/g, '');
    }
  }

  const filenameMatch = header.match(/filename="?([^";]+)"?/i);
  return filenameMatch?.[1]?.trim() || fallbackFilename;
}

export async function downloadResponseAsFile(response: Response, fallbackFilename: string) {
  const filename = getFilenameFromContentDisposition(response.headers.get('Content-Disposition'), fallbackFilename);
  await saveBlobAsFile(filename, await response.blob());
}
