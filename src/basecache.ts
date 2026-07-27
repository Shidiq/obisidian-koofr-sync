import { App, normalizePath } from "obsidian";

/** Extensions eligible for three-way merge and base caching. */
export const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "csv", "canvas"]);
export const MAX_MERGE_SIZE = 1024 * 1024; // 1 MB

export function isMergeableTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Stores the last-synced content of small text files, keyed by vault path.
 * Lives in the plugin folder (config dir), which is always excluded from sync.
 * This is what upgrades Smart Conflict from "keep both" to a true 3-way merge.
 */
export class BaseCache {
  private cache: Record<string, string> = {};
  private dirty = false;
  private filePath: string;

  constructor(private app: App, pluginDir: string) {
    this.filePath = normalizePath(`${pluginDir}/basecache.json`);
  }

  async load(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.filePath)) {
        this.cache = JSON.parse(await this.app.vault.adapter.read(this.filePath));
      }
    } catch (e) {
      console.warn("[koofr-sync] failed to load basecache.json, starting fresh", e);
      this.cache = {};
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.cache));
      this.dirty = false;
    } catch (e) {
      console.warn("[koofr-sync] failed to save basecache.json", e);
    }
  }

  get(path: string): string | undefined {
    return this.cache[path];
  }

  /** Store base content for a path; ignores non-text or oversized content. */
  set(path: string, content: ArrayBuffer): void {
    if (!isMergeableTextPath(path) || content.byteLength > MAX_MERGE_SIZE) return;
    this.cache[path] = new TextDecoder("utf-8").decode(content);
    this.dirty = true;
  }

  delete(path: string): void {
    if (path in this.cache) {
      delete this.cache[path];
      this.dirty = true;
    }
  }

  /** Drop entries for paths that no longer exist on either side. */
  prune(livePaths: Set<string>): void {
    for (const key of Object.keys(this.cache)) {
      if (!livePaths.has(key)) {
        delete this.cache[key];
        this.dirty = true;
      }
    }
  }
}
