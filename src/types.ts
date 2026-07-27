export interface LocalEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface RemoteEntry {
  path: string; // vault-relative, decoded, no leading slash
  isDir: boolean;
  size: number;
  etag: string | null; // quotes / W/ prefix stripped
  mtime: number | null; // getlastmodified — informational only, never compared for change detection
}

export interface SyncRecord {
  localMtime: number;
  localSize: number;
  remoteEtag: string | null;
  remoteSize: number;
  syncedAt: number;
}

export type PlanAction =
  | "upload"
  | "download"
  | "delete_local"
  | "delete_remote"
  | "conflict"
  | "skip"
  | "adopt_record";

export interface PlanItem {
  path: string;
  action: PlanAction;
  local?: LocalEntry;
  remote?: RemoteEntry;
  record?: SyncRecord;
  overwrites: boolean;
  reason: string;
}

export interface SyncPlan {
  items: PlanItem[];
  totalConsidered: number;
  destructiveCount: number;
}

export type SyncPhase = "idle" | "listing" | "planning" | "applying" | "saving" | "error";

export interface SyncProgress {
  phase: SyncPhase;
  done: number;
  total: number;
  failures: string[];
}

export type ConflictAction = "smart" | "keep_newer" | "keep_local" | "keep_remote";

export interface KoofrSyncSettings {
  webdavUrl: string;
  username: string;
  password: string;
  remoteBaseDir: string;
  ignoreRegexText: string;
  conflictAction: ConflictAction;
  abortPercentage: number;
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  startupDelaySeconds: number;
  concurrency: number;
  lastSyncAt: number;
}

export interface PluginData {
  settings: KoofrSyncSettings;
  records: Record<string, SyncRecord>;
}

export const DEFAULT_SETTINGS: KoofrSyncSettings = {
  webdavUrl: "https://app.koofr.net/dav/Koofr",
  username: "",
  password: "",
  remoteBaseDir: "ObsidianVault",
  ignoreRegexText: "",
  conflictAction: "smart",
  abortPercentage: 50,
  autoSyncMinutes: 0,
  syncOnStartup: false,
  startupDelaySeconds: 15,
  concurrency: 5,
  lastSyncAt: 0,
};
