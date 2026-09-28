import { describe, expect, it } from 'vitest';
import { buildTranscriptionForm, speechContentType, TRANSCRIPTION_FIELDS } from '../audio-proxy.util';

describe('buildTranscriptionForm', () => {
  it('forwards the uploaded audio as a named file part', async () => {
    const audio = Buffer.from('RIFF....WAVEfmt ');
    const form = buildTranscriptionForm({ buffer: audio, originalname: 'turn.wav', mimetype: 'audio/wav' }, { model: 'whisper-base' });

    const file = form.get('file') as File;
    expect(file.name).toBe('turn.wav');
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
    expect(form.get('model')).toBe('whisper-base');
  });

  it('forwards only the OpenAI transcription fields the client sent', () => {
    const form = buildTranscriptionForm(
      { buffer: Buffer.from('x') },
      { language: 'en', temperature: 0, response_format: '', stream: 'true', prompt: undefined },
    );
    expect(form.get('language')).toBe('en');
    expect(form.get('temperature')).toBe('0');
    expect(form.has('response_format')).toBe(false);
    expect(form.has('stream')).toBe(false);
    expect(form.has('prompt')).toBe(false);
    expect(TRANSCRIPTION_FIELDS).not.toContain('file');
  });

  it('names and types a bare upload so engines still accept it', () => {
    const file = buildTranscriptionForm({ buffer: Buffer.from('x') }, undefined).get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('application/octet-stream');
  });
});

describe('speechContentType', () => {
  it('matches the requested response_format', () => {
    expect(speechContentType({ response_format: 'wav' })).toBe('audio/wav');
    expect(speechContentType({ response_format: 'flac' })).toBe('audio/flac');
    expect(speechContentType({ response_format: 'pcm' })).toBe('audio/pcm');
  });

  it("defaults to mp3, OpenAI's default", () => {
    expect(speechContentType({})).toBe('audio/mpeg');
    expect(speechContentType(undefined)).toBe('audio/mpeg');
  });

  it('does not claim a type it does not know', () => {
    expect(speechContentType({ response_format: 'ogg' })).toBe('application/octet-stream');
  });
});
