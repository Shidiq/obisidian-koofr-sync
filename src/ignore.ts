export interface CompiledIgnores {
  regexes: RegExp[];
  invalidLines: string[];
}

/**
 * Parse user ignore config: one regex per line.
 * Blank lines and lines starting with "//" are skipped.
 * Invalid regexes are collected (to warn the user) but never fatal.
 */
export function compileIgnores(text: string): CompiledIgnores {
  const regexes: RegExp[] = [];
  const invalidLines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    try {
      regexes.push(new RegExp(line));
    } catch {
      invalidLines.push(line);
    }
  }
  return { regexes, invalidLines };
}

/** Paths always ignored regardless of user config. `configDir` is e.g. ".obsidian". */
export function builtinIgnores(configDir: string): RegExp[] {
  const esc = configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^${esc}(/|$)`),
    /(^|\/)\.git(\/|$)/,
    /(^|\/)\.trash(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)desktop\.ini$/,
    /(^|\/)Thumbs\.db$/,
    /(^|\/)\.DS_Store$/,
  ];
}

/** `path` must be vault-relative with forward slashes. */
export function isIgnored(path: string, regexes: RegExp[]): boolean {
  return regexes.some((r) => r.test(path));
}
