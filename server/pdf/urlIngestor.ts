/** SSRF-guarded URL fetcher that safely downloads public web articles and delegates HTML parsing. */
import dns from 'node:dns/promises';
import net from 'node:net';
import { extractArticleFromHtml } from './htmlArticleExtractor.ts';
import type { ExtractedArticle } from './articleTypes.ts';

/** Returns true for loopback, private, link-local, CGNAT, or reserved IPv4/IPv6 ranges. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast / reserved
    return false;
  }
  if (net.isIPv6(normalized)) {
    const lower = normalized.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // Link-local
    return false;
  }
  return true;
}

/** Validates URL scheme and DNS resolution to block SSRF access to internal networks. */
export async function validateSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format. Please provide a valid http:// or https:// link.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('Local or internal hostnames cannot be fetched.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('Private or loopback IP addresses are blocked.');
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true }).catch(() => {
    throw new Error(`Could not resolve hostname "${hostname}".`);
  });

  if (!records.length || records.some((r) => isPrivateOrReservedIp(r.address))) {
    throw new Error('Target URL resolved to a restricted internal network address.');
  }

  return parsed;
}

/** Fetches a public article URL safely (with timeout and size cap) and extracts its prose. */
export async function fetchAndExtractUrl(rawUrl: string): Promise<ExtractedArticle> {
  const safeUrl = await validateSafePublicUrl(rawUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(safeUrl.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'FolioBrief-Personal-Reader/1.0 (+https://localhost)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      },
    });

    if (!res.ok) {
      throw new Error(
        `Failed to fetch URL (HTTP ${res.status}). If this site blocks automated downloads, export the page as PDF in Safari/Chrome or paste the article text.`
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/pdf')) {
      throw new Error('DIRECT_PDF_RESPONSE');
    }

    const html = await res.text();
    if (html.length > 6_000_000) {
      throw new Error('Webpage exceeds 6 MB size limit.');
    }

    return extractArticleFromHtml(html, res.url || safeUrl.toString());
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Timed out waiting for the article URL to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
