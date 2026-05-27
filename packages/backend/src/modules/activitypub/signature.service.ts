import { createHash, createSign, createVerify } from 'node:crypto';
import net from 'node:net';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

function parseSignatureHeader(header: string): Record<string, string> {
  return header
    .split(',')
    .map((segment) => segment.trim())
    .reduce<Record<string, string>>((acc, segment) => {
      const separatorIndex = segment.indexOf('=');
      if (separatorIndex === -1) {
        return acc;
      }

      const key = segment.slice(0, separatorIndex).trim();
      const value = segment
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^"|"$/g, '');
      acc[key] = value;
      return acc;
    }, {});
}

function isPrivateIp(host: string): boolean {
  if (host === 'localhost') return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return host.startsWith('10.') || host.startsWith('127.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  }

  if (ipVersion === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd');
  }

  return false;
}

@Injectable()
export class SignatureService {
  private buildDigest(body: string): string {
    return `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
  }

  private buildSigningString(params: {
    headers: string[];
    method: string;
    pathWithQuery: string;
    host: string;
    date: string;
    digest: string;
    contentType: string;
  }): string {
    return params.headers
      .map((header) => {
        switch (header) {
          case '(request-target)':
            return `(request-target): ${params.method.toLowerCase()} ${params.pathWithQuery}`;
          case 'host':
            return `host: ${params.host}`;
          case 'date':
            return `date: ${params.date}`;
          case 'digest':
            return `digest: ${params.digest}`;
          case 'content-type':
            return `content-type: ${params.contentType}`;
          default:
            return `${header}:`;
        }
      })
      .join('\n');
  }

  createSignedHeaders(params: { url: string; body: string; keyId: string; privateKeyPem: string; contentType?: string; method?: string }) {
    const method = params.method ?? 'POST';
    const url = new URL(params.url);
    const date = new Date().toUTCString();
    const digest = this.buildDigest(params.body);
    const contentType = params.contentType ?? 'application/activity+json';
    const headers = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
    const signingString = this.buildSigningString({
      headers,
      method,
      pathWithQuery: `${url.pathname}${url.search}`,
      host: url.host,
      date,
      digest,
      contentType,
    });
    const signer = createSign('RSA-SHA256');
    signer.update(signingString);
    const signature = signer.sign(params.privateKeyPem, 'base64');

    return {
      Date: date,
      Digest: digest,
      Host: url.host,
      'Content-Type': contentType,
      Signature: `keyId="${params.keyId}",algorithm="hs2019",headers="${headers.join(' ')}",signature="${signature}"`,
    };
  }

  async fetchRemoteActor(actorUri: string): Promise<Record<string, unknown>> {
    const url = new URL(actorUri);
    if (url.protocol !== 'https:' || isPrivateIp(url.hostname)) {
      throw new Error('Only public HTTPS actor URLs are allowed');
    }

    const response = await fetch(actorUri, {
      headers: {
        Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch actor profile: ${response.status}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async verifyIncomingRequest(params: { request: Request; body: string; actorUri?: string }): Promise<boolean> {
    const signatureHeader = params.request.get('signature');
    const date = params.request.get('date');
    const digest = params.request.get('digest');
    const contentType = params.request.get('content-type') || 'application/activity+json';

    if (!signatureHeader || !date || !digest) {
      return false;
    }

    if (digest !== this.buildDigest(params.body)) {
      return false;
    }

    const signatureParts = parseSignatureHeader(signatureHeader);
    const signedHeaders = (signatureParts.headers || '(request-target) host date digest content-type').split(' ');
    const actor = params.actorUri ? await this.fetchRemoteActor(params.actorUri) : null;
    const publicKey = (actor?.publicKey as { publicKeyPem?: string } | undefined)?.publicKeyPem;
    if (!publicKey || !signatureParts.signature) {
      return false;
    }

    const signingString = this.buildSigningString({
      headers: signedHeaders,
      method: params.request.method,
      pathWithQuery: params.request.originalUrl,
      host: params.request.get('host') || '',
      date,
      digest,
      contentType,
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingString);
    return verifier.verify(publicKey, signatureParts.signature, 'base64');
  }
}
