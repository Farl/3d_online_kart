import { writeFileSync } from 'node:fs';

// Keep the exported name for existing clients; deployment selects the backend.
const host = process.env.PARTYSERVER_HOST;
if (!host || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host)) {
  throw new Error('PARTYSERVER_HOST must contain a hostname and optional port');
}
const url = new URL(`https://${host}`);
if (url.host !== host.toLowerCase()) throw new Error('Invalid PARTYSERVER_HOST');
writeFileSync(new URL('../env.js', import.meta.url),
  `export const PARTYKIT_HOST = ${JSON.stringify(host)};\n`);
