/**
 * fetcher/security.ts
 * URL and DNS-level security validation for SSRF protection.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import type { URL } from 'node:url';

// ============================================================================
// Private IP / hostname patterns
// ============================================================================

/** Private IPv4/IPv6 ranges blocked for SSRF protection */
const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
  /^192\.168\./, // Private Class C
  /^169\.254\./, // Link-local (AWS metadata, etc.)
  /^0\./, // Current network
  /^::1$/, // IPv6 loopback
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
];

export function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === 'localhost.localdomain') return true;
  return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname));
}

// ============================================================================
// DNS resolver
// ============================================================================

export async function defaultDnsResolver(hostname: string): Promise<string> {
  const result = await dnsLookup(hostname);
  return result.address;
}

// ============================================================================
// Synchronous URL security check (protocol, hostname, credentials, port)
// ============================================================================

/** Blocked well-known service ports (not general web ports like 8080/8443) */
const BLOCKED_PORTS = [22, 23, 25, 53, 110, 143, 3306, 5432, 6379, 9200];

export function validateUrlSecurity(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `URL protocol "${url.protocol}" not allowed — only http: and https: are supported`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (isPrivateHostname(hostname)) {
    throw new Error(`Access to private/internal address "${hostname}" is blocked for security`);
  }

  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.includes(port)) {
    throw new Error(`Access to port ${port} is blocked for security`);
  }
}

// ============================================================================
// Async URL security check — resolves hostname via DNS and blocks private IPs
// ============================================================================

/**
 * Resolves the hostname via DNS and verifies the resulting IP is not private.
 * Returns the resolved IP string for use as a pinned DNS value in the HTTP agent.
 */
export async function validateUrlSecurityAsync(
  url: URL,
  resolver?: (hostname: string) => Promise<string>,
): Promise<string> {
  const resolve = resolver ?? defaultDnsResolver;
  let resolvedIp: string;
  try {
    resolvedIp = await resolve(url.hostname);
  } catch {
    throw new Error(`DNS resolution failed for "${url.hostname}"`);
  }
  if (isPrivateHostname(resolvedIp)) {
    throw new Error(
      `Resolved IP "${resolvedIp}" for "${url.hostname}" is blocked (private/internal address)`,
    );
  }
  return resolvedIp;
}
