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
  const blob = await response.blob();
  const filename = getFilenameFromContentDisposition(response.headers.get('Content-Disposition'), fallbackFilename);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 0);
}
