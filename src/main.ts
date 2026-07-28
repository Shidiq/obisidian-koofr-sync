import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, KoofrSyncSettings, SyncProgress, SyncRecord } from "./types";
import { KoofrSyncSettingTab } from "./settings";
import { WebDavClient } from "./webdav";
import { SyncEngine, FullSyncPlan } from "./sync";
import { BaseCache } from "./basecache";
import { compileIgnores, builtinIgnores } from "./ignore";

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default class KoofrSyncPlugin extends Plugin {
  settings: KoofrSyncSettings = { ...DEFAULT_SETTINGS };
  records: Record<string, SyncRecord> = {};
  private statusBar: HTMLElement | null = null;
  private syncing = false;
  private autoSyncTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadAll();

    this.addSettingTab(new KoofrSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Koofr Sync: sync now", () => {
      void this.runSync(false, true);
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.runSync(false, true),
    });

    this.addCommand({
      id: "dry-run",
      name: "Dry run (show plan, change nothing)",
      callback: () => void this.runSync(true, true),
    });

    this.statusBar = this.addStatusBarItem();
    this.setStatus(this.settings.lastSyncAt ? `Koofr: ✓ ${formatTime(this.settings.lastSyncAt)}` : "Koofr: idle");

    this.restartAutoSync();

    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => void this.runSync(false, false), this.settings.startupDelaySeconds * 1000);
      });
    }
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
  }

  async loadAll(): Promise<void> {
    const data = (await this.loadData()) as { settings?: Partial<KoofrSyncSettings>; records?: Record<string, SyncRecord> } | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.records = data?.records ?? {};
  }

  async saveAll(): Promise<void> {
    await this.saveData({ settings: this.settings, records: this.records });
  }

  restartAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.settings.autoSyncMinutes > 0) {
      this.autoSyncTimer = window.setInterval(
        () => void this.runSync(false, false),
        this.settings.autoSyncMinutes * 60 * 1000
      );
      this.registerInterval(this.autoSyncTimer);
    }
  }

  private setStatus(text: string): void {
    this.statusBar?.setText(text);
  }

  private onProgress = (p: SyncProgress): void => {
    switch (p.phase) {
      case "listing":
        this.setStatus("Koofr: listing…");
        break;
      case "planning":
        this.setStatus("Koofr: planning…");
        break;
      case "applying":
        this.setStatus(`Koofr: ${p.done}/${p.total}`);
        break;
      case "saving":
        this.setStatus("Koofr: saving…");
        break;
    }
  };

  async runSync(dryRun: boolean, interactive: boolean): Promise<void> {
    const s = this.settings;
    if (!s.webdavUrl || !s.username || !s.password) {
      if (interactive) new Notice("Koofr Sync: configure the WebDAV URL, username, and app password in settings first.");
      return;
    }
    if (this.syncing) {
      if (interactive) new Notice("Koofr Sync: a sync is already running.");
      return;
    }
    this.syncing = true;

    try {
      const { regexes, invalidLines } = compileIgnores(s.ignoreRegexText);
      if (invalidLines.length > 0) {
        new Notice(`Koofr Sync: skipping invalid ignore regex: ${invalidLines.join(", ")}`);
      }
      const ignores = [...builtinIgnores(this.app.vault.configDir), ...regexes];

      const client = new WebDavClient(s.webdavUrl, s.username, s.password, s.remoteBaseDir);
      const baseCache = new BaseCache(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/koofr-sync`);
      await baseCache.load();

      const engine = new SyncEngine({
        app: this.app,
        client,
        settings: s,
        records: this.records,
        baseCache,
        ignores,
        persist: () => this.saveAll(),
        onProgress: this.onProgress,
      });

      const plan = await engine.buildPlan();
      for (const w of plan.warnings) console.warn(`[koofr-sync] ${w}`);

      if (dryRun) {
        this.printPlan(plan);
        const guard = engine.checkGuard(plan);
        const changes = plan.items.filter((i) => i.action !== "skip").length;
        new Notice(
          `Koofr Sync dry run: ${changes} planned change(s) across ${plan.totalConsidered} files` +
            (guard ? ` — guard WOULD abort: see console` : "") +
            ". Full plan in the developer console."
        );
        if (guard) console.warn(`[koofr-sync] ${guard}`);
        this.setStatus("Koofr: idle");
        return;
      }

      const guard = engine.checkGuard(plan);
      if (guard) {
        new Notice(guard, 0);
        this.setStatus("Koofr: aborted");
        return;
      }

      await client.ensureBaseDir();
      const result = await engine.execute(plan);

      s.lastSyncAt = Date.now();
      await this.saveAll();

      const c = result.counts;
      const parts: string[] = [];
      if (c.uploaded) parts.push(`${c.uploaded} up`);
      if (c.downloaded) parts.push(`${c.downloaded} down`);
      if (c.merged) parts.push(`${c.merged} merged`);
      if (c.keptBoth) parts.push(`${c.keptBoth} kept both`);
      if (c.deletedLocal + c.deletedRemote) parts.push(`${c.deletedLocal + c.deletedRemote} deleted`);
      if (result.failures.length) parts.push(`${result.failures.length} failed`);
      const summary = parts.length ? parts.join(", ") : "no changes";

      if (result.failures.length > 0) {
        for (const f of result.failures) console.error(`[koofr-sync] ${f.path}: ${f.error}`);
        const first = result.failures[0];
        const more = result.failures.length > 1 ? ` (+${result.failures.length - 1} more)` : "";
        new Notice(
          `Koofr Sync finished with errors: ${summary}.\n${first.path}: ${first.error}${more}\n` +
            `Full list in the developer console.`,
          15000
        );
      } else if (interactive || parts.length > 0) {
        new Notice(`Koofr Sync: ${summary}.`);
      }
      if (c.mergedWithMarkers.length > 0) {
        new Notice(
          `Koofr Sync: conflicts written into:\n${c.mergedWithMarkers.join("\n")}`,
          0
        );
      }

      this.setStatus(`Koofr: ✓ ${formatTime(s.lastSyncAt)}`);
    } catch (e) {
      console.error("[koofr-sync] sync failed", e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Koofr Sync failed: ${msg}`, 0);
      this.setStatus("Koofr: error");
    } finally {
      this.syncing = false;
    }
  }

  private printPlan(plan: FullSyncPlan): void {
    const groups = new Map<string, { path: string; reason: string }[]>();
    for (const item of plan.items) {
      if (item.action === "skip") continue;
      const list = groups.get(item.action) ?? [];
      list.push({ path: item.path, reason: item.reason });
      groups.set(item.action, list);
    }
    console.log(
      `[koofr-sync] DRY RUN — ${plan.totalConsidered} files considered, ` +
        `${plan.destructiveCount} destructive, ${plan.dropRecords.length} stale records to drop`
    );
    for (const [action, list] of groups) {
      console.log(`[koofr-sync] ${action} (${list.length}):`);
      for (const { path, reason } of list) console.log(`    ${path}  — ${reason}`);
    }
    if (plan.dropRecords.length > 0) console.log(`[koofr-sync] drop records:`, plan.dropRecords);
  }
}
