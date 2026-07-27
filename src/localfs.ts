import { App, TFile, normalizePath } from "obsidian";
import { LocalEntry } from "./types";

export function listLocal(app: App): LocalEntry[] {
  return app.vault.getFiles().map((f) => ({
    path: f.path,
    size: f.stat.size,
    mtime: f.stat.mtime,
  }));
}

export async function readLocal(app: App, path: string): Promise<ArrayBuffer> {
  return app.vault.adapter.readBinary(normalizePath(path));
}

/**
 * Write a file (creating parent folders), stamping the given mtime,
 * then return the stat we actually ended up with.
 */
export async function writeLocal(
  app: App,
  path: string,
  data: ArrayBuffer,
  mtime: number | null
): Promise<LocalEntry> {
  const norm = normalizePath(path);
  await ensureParentFolders(app, norm);
  const options = mtime ? { mtime } : undefined;
  await app.vault.adapter.writeBinary(norm, data, options);
  const stat = await app.vault.adapter.stat(norm);
  return {
    path: norm,
    size: stat?.size ?? data.byteLength,
    mtime: stat?.mtime ?? mtime ?? Date.now(),
  };
}

/** Delete via Obsidian trash (recoverable), falling back to system trash behavior. */
export async function trashLocal(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFile) {
    await app.vault.trash(file, false);
  } else if (await app.vault.adapter.exists(normalizePath(path))) {
    await app.vault.adapter.trashLocal(normalizePath(path));
  }
}

export async function ensureParentFolders(app: App, path: string): Promise<void> {
  const parts = path.split("/");
  parts.pop();
  if (parts.length === 0) return;
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current) && !(await app.vault.adapter.exists(current))) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // folder may have been created concurrently — fine
      }
    }
  }
}
