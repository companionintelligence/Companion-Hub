/**
 * Keeps the OpenAI audio contract intact through the Hub's `/v1/audio/*`
 * proxy routes. OpenAI clients (the Home Assistant voice bridge, SDKs)
 * upload transcription audio as multipart/form-data and pick the speech
 * format with `response_format`; both have to survive the hop to Lemonade
 * or a cloud provider.
 */

/** The part of a multer upload these helpers read. */
export interface UploadedAudio {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
}

/** OpenAI's upload limit for `/v1/audio/transcriptions`. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/** Transcription fields forwarded to the engine when the client sent them. */
export const TRANSCRIPTION_FIELDS = ['model', 'language', 'prompt', 'response_format', 'temperature'] as const;

/** Rebuild the client's multipart upload as a FormData the engine accepts. */
export function buildTranscriptionForm(file: UploadedAudio, fields: Record<string, unknown> | undefined): FormData {
  const form = new FormData();
  const audio = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'application/octet-stream' });
  form.append('file', audio, file.originalname || 'audio.wav');
  for (const key of TRANSCRIPTION_FIELDS) {
    const value = fields?.[key];
    if (typeof value === 'string' && value !== '') form.append(key, value);
    else if (typeof value === 'number' && Number.isFinite(value)) form.append(key, String(value));
  }
  return form;
}

const SPEECH_CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

/** Content-Type for a speech response, from the request's `response_format` (OpenAI's default is mp3). */
export function speechContentType(body: Record<string, unknown> | undefined): string {
  const format = typeof body?.response_format === 'string' ? body.response_format : 'mp3';
  return SPEECH_CONTENT_TYPES[format] ?? 'application/octet-stream';
}
