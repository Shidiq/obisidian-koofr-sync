import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type KoofrSyncPlugin from "./main";
import { WebDavClient } from "./webdav";
import { compileIgnores } from "./ignore";

export class KoofrSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: KoofrSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Server").setHeading();

    new Setting(containerEl)
      .setName("WebDAV URL")
      .setDesc("For Koofr: https://app.koofr.net/dav/Koofr")
      .addText((t) =>
        t.setPlaceholder("https://app.koofr.net/dav/Koofr").setValue(s.webdavUrl).onChange(async (v) => {
          s.webdavUrl = v.trim();
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your Koofr account email.")
      .addText((t) =>
        t.setValue(s.username).onChange(async (v) => {
          s.username = v.trim();
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("App password")
      .setDesc(
        "Create one in Koofr → Preferences → Password → App passwords. Never use your account password. Note: stored in plain text in this plugin's data.json."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.password).onChange(async (v) => {
          s.password = v;
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName("Remote base folder")
      .setDesc("Folder on the server that holds this vault. Created automatically on first sync.")
      .addText((t) =>
        t.setPlaceholder("ObsidianVault").setValue(s.remoteBaseDir).onChange(async (v) => {
          s.remoteBaseDir = v.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("Check connectivity")
      .setDesc("Verify the WebDAV URL and credentials.")
      .addButton((b) =>
        b.setButtonText("Check").setCta().onClick(async () => {
          if (!s.webdavUrl || !s.username || !s.password) {
            new Notice("Fill in the WebDAV URL, username, and app password first.");
            return;
          }
          b.setDisabled(true).setButtonText("Checking…");
          try {
            const client = new WebDavClient(s.webdavUrl, s.username, s.password, s.remoteBaseDir);
            const result = await client.check();
            new Notice(result.message, result.ok ? 5000 : 10000);
          } finally {
            b.setDisabled(false).setButtonText("Check");
          }
        })
      );

    new Setting(containerEl).setName("Sync behavior").setHeading();

    new Setting(containerEl)
      .setName("Paths to ignore (regex)")
      .setDesc(
        "One regular expression per line; matching vault paths are skipped in both directions. Lines starting with // are comments. Example: ^Private/ or \\.tmp$"
      )
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.inputEl.cols = 40;
        t.setPlaceholder("^Private/\n\\.tmp$").setValue(s.ignoreRegexText).onChange(async (v) => {
          s.ignoreRegexText = v;
          const { invalidLines } = compileIgnores(v);
          if (invalidLines.length > 0) {
            new Notice(`Invalid regex (will be skipped): ${invalidLines.join(", ")}`);
          }
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName("Action for conflicts")
      .setDesc(
        "Smart: 3-way merge for small text files (conflict markers if edits overlap), keep both copies otherwise. \"Keep newer\" trusts the server's timestamps, which may be unreliable."
      )
      .addDropdown((d) =>
        d
          .addOption("smart", "Smart conflict (merge / keep both)")
          .addOption("keep_newer", "Keep newer")
          .addOption("keep_local", "Keep local")
          .addOption("keep_remote", "Keep remote")
          .setValue(s.conflictAction)
          .onChange(async (v) => {
            s.conflictAction = v as typeof s.conflictAction;
            await this.plugin.saveAll();
          })
      );

    new Setting(containerEl)
      .setName("Abort sync if modification above percentage")
      .setDesc(
        "If more than this percentage of files would be deleted or overwritten, the sync aborts before touching anything. 100 disables the guard."
      )
      .addSlider((sl) =>
        sl.setLimits(0, 100, 5).setValue(s.abortPercentage).setDynamicTooltip().onChange(async (v) => {
          s.abortPercentage = v;
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl).setName("Triggers").setHeading();

    new Setting(containerEl)
      .setName("Auto sync every N minutes")
      .setDesc("0 disables auto sync.")
      .addText((t) =>
        t.setPlaceholder("0").setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.autoSyncMinutes = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveAll();
          this.plugin.restartAutoSync();
        })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync shortly after Obsidian launches.")
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("Startup sync delay (seconds)")
      .addText((t) =>
        t.setValue(String(s.startupDelaySeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.startupDelaySeconds = isNaN(n) || n < 0 ? 15 : n;
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Concurrency")
      .setDesc("Parallel transfers during sync.")
      .addSlider((sl) =>
        sl.setLimits(1, 10, 1).setValue(s.concurrency).setDynamicTooltip().onChange(async (v) => {
          s.concurrency = v;
          await this.plugin.saveAll();
        })
      );
  }
}
