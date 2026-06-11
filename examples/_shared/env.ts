import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads the repo-root `.env.local` into process.env (existing vars win).
 * Examples use this to pick up OPENAI_API_KEY without a dotenv dependency.
 */
export function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  let text: string;
  try {
    text = readFileSync(resolve(here, '../../.env.local'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
