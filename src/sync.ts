import { App } from "obsidian";
import {
  KoofrSyncSettings,
  LocalEntry,
  PlanItem,
  RemoteEntry,
  SyncPlan,
  SyncProgress,
  SyncRecord,
} from "./types";
import { WebDavClient } from "./webdav";
import { BaseCache, MAX_MERGE_SIZE, isMergeableTextPath } from "./basecache";
import { threeWayMerge, conflictCopyName, buffersEqual } from "./conflict";
import { listLocal, readLocal, writeLocal, trashLocal } from "./localfs";
import { isIgnored } from "./ignore";
import { pLimit } from "./concurrency";

export interface FullSyncPlan extends SyncPlan {
  dropRecords: string[];
  localFileCount: number;
  warnings: string[];
}

export interface SyncCounts {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  merged: number;
  mergedWithMarkers: string[];
  keptBoth: number;
  adopted: number;
  skipped: number;
}

export interface SyncResult {
  aborted: string | null;
  counts: SyncCounts;
  failures: { path: string; error: string }[];
  warnings: string[];
}

export interface EngineDeps {
  app: App;
  client: WebDavClient;
  settings: KoofrSyncSettings;
  records: Record<string, SyncRecord>;
  baseCache: BaseCache;
  ignores: RegExp[];
  persist: () => Promise<void>;
  onProgress: (p: SyncProgress) => void;
}

const SAVE_EVERY = 20;

export class SyncEngine {
  constructor(private deps: EngineDeps) {}

  async buildPlan(): Promise<FullSyncPlan> {
    const { app, client, records, ignores, settings, onProgress } = this.deps;
    onProgress({ phase: "listing", done: 0, total: 0, failures: [] });

    const [localAll, remoteAll] = await Promise.all([
      Promise.resolve(listLocal(app)),
      client.walk(settings.concurrency),
    ]);

    const warnings: string[] = [];
    const local = localAll.filter((e) => !isIgnored(e.path, ignores));
    const remote = remoteAll.filter((e) => !e.isDir && !isIgnored(e.path, ignores));

    // Warn about vault paths differing only by case (trouble on Windows/Koofr).
    const lowerSeen = new Map<string, string>();
    for (const e of local) {
      const lower = e.path.toLowerCase();
      const prev = lowerSeen.get(lower);
      if (prev) warnings.push(`Paths differ only by case: "${prev}" vs "${e.path}"`);
      lowerSeen.set(lower, e.path);
    }

    onProgress({ phase: "planning", done: 0, total: 0, failures: [] });

    const localMap = new Map(local.map((e) => [e.path, e]));
    const remoteMap = new Map(remote.map((e) => [e.path, e]));
    const recordPaths = Object.keys(records).filter((p) => !isIgnored(p, ignores));

    const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...recordPaths]);

    const items: PlanItem[] = [];
    const dropRecords: string[] = [];

    for (const path of allPaths) {
      const L = localMap.get(path);
      const R = remoteMap.get(path);
      const B = records[path];
      items.push(...this.classify(path, L, R, B, dropRecords));
    }

    const destructiveCount = items.filter((i) => i.overwrites).length;
    return {
      items,
      totalConsidered: allPaths.size,
      destructiveCount,
      dropRecords,
      localFileCount: local.length,
      warnings,
    };
  }

  private classify(
    path: string,
    L: LocalEntry | undefined,
    R: RemoteEntry | undefined,
    B: SyncRecord | undefined,
    dropRecords: string[]
  ): PlanItem[] {
    const item = (action: PlanItem["action"], overwrites: boolean, reason: string): PlanItem => ({
      path,
      action,
      local: L,
      remote: R,
      record: B,
      overwrites,
      reason,
    });

    if (!B) {
      if (L && !R) return [item("upload", false, "new local file")];
      if (!L && R) return [item("download", false, "new remote file")];
      if (L && R) {
        if (L.size === R.size) {
          return [item("adopt_record", false, "exists on both sides with equal size (first sync)")];
        }
        return [item("conflict", true, "exists on both sides with different content (first sync, no history)")];
      }
      return [];
    }

    const localChanged = L ? L.mtime !== B.localMtime || L.size !== B.localSize : false;
    const remoteChanged = R
      ? R.etag !== null && B.remoteEtag !== null
        ? R.etag !== B.remoteEtag
        : R.size !== B.remoteSize
      : false;

    if (L && R) {
      if (!localChanged && !remoteChanged) return [item("skip", false, "unchanged")];
      if (localChanged && !remoteChanged) return [item("upload", false, "local edit")];
      if (!localChanged && remoteChanged) return [item("download", true, "remote edit")];
      return [item("conflict", true, "changed on both sides")];
    }
    if (!L && R) {
      if (remoteChanged) return [item("download", false, "deleted locally but edited remotely — edit wins")];
      return [item("delete_remote", true, "deleted locally")];
    }
    if (L && !R) {
      if (localChanged) return [item("upload", false, "deleted remotely but edited locally — edit wins")];
      return [item("delete_local", true, "deleted remotely")];
    }
    dropRecords.push(path);
    return [];
  }

  /** Returns an abort message, or null if the plan passes the safety guard. */
  checkGuard(plan: FullSyncPlan): string | null {
    const { abortPercentage } = this.deps.settings;

    const deleteLocalCount = plan.items.filter((i) => i.action === "delete_local").length;
    if (plan.localFileCount > 0 && deleteLocalCount >= plan.localFileCount) {
      return `Sync aborted: this sync would delete ALL ${plan.localFileCount} local files. The remote base folder is probably wrong or empty.`;
    }

    if (abortPercentage >= 100 || plan.totalConsidered === 0) return null;
    const pct = (plan.destructiveCount / plan.totalConsidered) * 100;
    if (pct > abortPercentage) {
      return `Sync aborted: ${Math.round(pct)}% of ${plan.totalConsidered} files would be deleted or overwritten (threshold ${abortPercentage}%). Check the remote, or raise the threshold in settings.`;
    }
    return null;
  }

  async execute(plan: FullSyncPlan): Promise<SyncResult> {
    const { client, records, baseCache, settings, persist, onProgress } = this.deps;
    client.resetDirCache();

    const counts: SyncCounts = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      merged: 0,
      mergedWithMarkers: [],
      keptBoth: 0,
      adopted: 0,
      skipped: plan.items.filter((i) => i.action === "skip").length,
    };
    const failures: { path: string; error: string }[] = [];

    const transfers = plan.items.filter((i) =>
      ["upload", "download", "conflict", "adopt_record"].includes(i.action)
    );
    const deletes = plan.items.filter((i) => i.action === "delete_local" || i.action === "delete_remote");
    const total = transfers.length + deletes.length;

    let done = 0;
    let sinceSave = 0;
    const tick = async () => {
      done++;
      sinceSave++;
      onProgress({ phase: "applying", done, total, failures: failures.map((f) => f.path) });
      if (sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        await persist();
      }
    };

    const limit = pLimit(Math.max(1, settings.concurrency));
    // Names claimed by conflict copies during this run, so parallel conflicts can't collide.
    const claimedNames = new Set<string>();

    // Transfers first: a failed transfer must never be followed by its counterpart's delete.
    await Promise.all(
      transfers.map((item) =>
        limit(async () => {
          try {
            switch (item.action) {
              case "upload":
                await this.doUpload(item.path, item.local!);
                counts.uploaded++;
                break;
              case "download":
                await this.doDownload(item.path, item.remote!);
                counts.downloaded++;
                break;
              case "adopt_record":
                await this.doAdopt(item.path, item.local!, item.remote!);
                counts.adopted++;
                break;
              case "conflict":
                await this.resolveConflict(item, counts, claimedNames);
                break;
            }
          } catch (e) {
            failures.push({ path: item.path, error: e instanceof Error ? e.message : String(e) });
          }
          await tick();
        })
      )
    );

    await Promise.all(
      deletes.map((item) =>
        limit(async () => {
          try {
            if (item.action === "delete_local") {
              await trashLocal(this.deps.app, item.path);
              counts.deletedLocal++;
            } else {
              await client.deleteFile(item.path);
              counts.deletedRemote++;
            }
            delete records[item.path];
            baseCache.delete(item.path);
          } catch (e) {
            failures.push({ path: item.path, error: e instanceof Error ? e.message : String(e) });
          }
          await tick();
        })
      )
    );

    for (const path of plan.dropRecords) delete records[path];

    onProgress({ phase: "saving", done, total, failures: failures.map((f) => f.path) });
    baseCache.prune(new Set(Object.keys(records)));
    await baseCache.save();
    await persist();

    return { aborted: null, counts, failures, warnings: plan.warnings };
  }

  private async doUpload(path: string, local: LocalEntry): Promise<void> {
    const { app, client, records, baseCache } = this.deps;
    const data = await readLocal(app, path);
    await client.putFile(path, data);
    const stat = await client.statFile(path);
    records[path] = {
      localMtime: local.mtime,
      localSize: local.size,
      remoteEtag: stat?.etag ?? null,
      remoteSize: stat?.size ?? data.byteLength,
      syncedAt: Date.now(),
    };
    baseCache.set(path, data);
  }

  private async doDownload(path: string, remote: RemoteEntry): Promise<void> {
    const { app, client, records, baseCache } = this.deps;
    const data = await client.getFile(path);
    const entry = await writeLocal(app, path, data, remote.mtime);
    records[path] = {
      localMtime: entry.mtime,
      localSize: entry.size,
      remoteEtag: remote.etag,
      remoteSize: remote.size,
      syncedAt: Date.now(),
    };
    baseCache.set(path, data);
  }

  private async doAdopt(path: string, local: LocalEntry, remote: RemoteEntry): Promise<void> {
    const { app, records, baseCache } = this.deps;
    records[path] = {
      localMtime: local.mtime,
      localSize: local.size,
      remoteEtag: remote.etag,
      remoteSize: remote.size,
      syncedAt: Date.now(),
    };
    baseCache.set(path, await readLocal(app, path));
  }

  private async resolveConflict(
    item: PlanItem,
    counts: SyncCounts,
    claimedNames: Set<string>
  ): Promise<void> {
    const { app, client, settings } = this.deps;
    const path = item.path;
    const local = item.local!;
    const remote = item.remote!;

    const localData = await readLocal(app, path);
    const remoteData = await client.getFile(path);

    if (buffersEqual(localData, remoteData)) {
      await this.doAdopt(path, local, remote);
      counts.adopted++;
      return;
    }

    switch (settings.conflictAction) {
      case "keep_local":
        await this.doUpload(path, local);
        counts.uploaded++;
        return;
      case "keep_remote":
        await this.doDownload(path, remote);
        counts.downloaded++;
        return;
      case "keep_newer": {
        // The one place raw remote getlastmodified is compared (documented caveat).
        if (local.mtime >= (remote.mtime ?? 0)) {
          await this.doUpload(path, local);
          counts.uploaded++;
        } else {
          await this.doDownload(path, remote);
          counts.downloaded++;
        }
        return;
      }
      case "smart":
        break;
    }

    // No cached base (e.g. first sync) → merge against an empty base: whichever
    // side is empty loses cleanly, overlapping content gets conflict markers.
    const base = this.deps.baseCache.get(path) ?? "";
    const mergeable =
      isMergeableTextPath(path) &&
      localData.byteLength <= MAX_MERGE_SIZE &&
      remoteData.byteLength <= MAX_MERGE_SIZE;

    if (mergeable) {
      const decoder = new TextDecoder("utf-8");
      const style = path.toLowerCase().endsWith(".md") ? "mdFence" : "markers";
      const outcome = threeWayMerge(decoder.decode(localData), base, decoder.decode(remoteData), style);
      const mergedBuf = new TextEncoder().encode(outcome.text).buffer as ArrayBuffer;
      const entry = await writeLocal(app, path, mergedBuf, null);
      await this.doUpload(path, entry);
      counts.merged++;
      if (!outcome.clean) counts.mergedWithMarkers.push(path);
      return;
    }

    // Keep both: local version stays at its path (and overwrites remote);
    // the remote version is preserved under a "(conflict ...)" name on both sides.
    const copyName = conflictCopyName(
      path,
      new Date(),
      (p) => claimedNames.has(p) || app.vault.getAbstractFileByPath(p) !== null
    );
    claimedNames.add(copyName);
    const copyEntry = await writeLocal(app, copyName, remoteData, remote.mtime);
    await this.doUpload(copyName, copyEntry);
    await this.doUpload(path, local);
    counts.keptBoth++;
  }
}
