# Koofr Sync for Obsidian

Sync your Obsidian vault to [Koofr](https://koofr.eu) (or any WebDAV server). A focused, lightweight alternative to remotely-save with the features that matter:

- **Check connectivity** — verify your WebDAV URL and credentials from settings.
- **Regex paths to ignore** — one regex per line; matching paths are skipped in both directions.
- **Smart Conflict** — when a file changed on both sides: small text files get a true 3-way merge (git-style conflict markers only when edits overlap); binary or large files keep both copies (`note (conflict 2026-07-27 1532).md`).
- **Abort sync if modification above percentage** — if more than N% of your files would be deleted or overwritten, the sync aborts before touching anything. A sync that would delete *every* local file always aborts.
- Manual sync (ribbon icon / command), optional auto-sync every N minutes, optional sync on startup.
- **Dry run** command that prints the full sync plan to the developer console without changing anything.
- Works on mobile too (all HTTP goes through Obsidian's `requestUrl`, which bypasses CORS).

## Setup

1. In Koofr: **Preferences → Password → App passwords → Add new** — never use your account password.
2. In the plugin settings:
   - WebDAV URL: `https://app.koofr.net/dav/Koofr`
   - Username: your Koofr account email
   - App password: the password generated in step 1
   - Remote base folder: e.g. `ObsidianVault` (created automatically on first sync)
3. Click **Check connectivity**.
4. Run **Koofr Sync: Dry run** from the command palette and review the plan in the developer console (`Ctrl+Shift+I`).
5. Run **Koofr Sync: Sync now** (or click the ribbon icon).

## How syncing works

Each file's state at the last successful sync is recorded (local mtime/size, remote etag). On sync, both sides are compared against that record, so the plugin never has to trust server timestamps:

- changed on one side → copied to the other
- deleted on one side (and unchanged on the other) → deleted there too (local deletions go to Obsidian's trash, never permanently)
- an **edit always beats a delete** — edited files are never removed
- changed on both sides → conflict resolution (see below)

### Smart Conflict details

After each successful sync of a small text file (`.md .txt .json .csv .canvas`, ≤ 1 MB) its content is cached as a merge base. On conflict:

1. If both sides are byte-identical → nothing to do.
2. If a merge base exists → 3-way merge. Non-overlapping edits merge cleanly; overlapping edits produce git-style `<<<<<<< local / ======= / >>>>>>> remote` markers and a notification.
3. Otherwise (binary, large, or first-ever sync) → both versions are kept, on both sides.

## Notes & limitations

- The app password is stored **in plain text** in `.obsidian/plugins/koofr-sync/data.json`. Use a Koofr *app* password so it can be revoked independently.
- Empty folders are not synced (files only).
- The `.obsidian` config folder, `.git`, `.trash`, and OS junk files are always ignored.
- Whole files are transferred in memory — very large files (hundreds of MB) are not a good fit.
- "Keep newer" conflict mode compares server timestamps, which WebDAV servers don't always preserve; Smart Conflict (the default) never relies on them.

## Development

```
npm install
npm run dev     # watch build
npm run build   # type-check + production build
```

Then link the plugin folder into a vault:

```
New-Item -ItemType Junction -Path "<vault>\.obsidian\plugins\koofr-sync" -Target "<this repo>"
```
