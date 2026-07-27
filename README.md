# Koofr Sync for Obsidian

Sync your Obsidian vault to [Koofr](https://koofr.eu) (or any WebDAV server). A focused, lightweight alternative to remotely-save with the features that matter:

- **Check connectivity** — verify your WebDAV URL and credentials from settings.
- **Regex paths to ignore** — one regex per line; matching paths are skipped in both directions.
- **Smart Conflict** — when a file changed on both sides: small text files get a true 3-way merge (git-style conflict markers only when edits overlap); binary or large files keep both copies (`note (conflict 2026-07-27 1532).md`).
- **Abort sync if modification above percentage** — if more than N% of your files would be deleted or overwritten, the sync aborts before touching anything. A sync that would delete *every* local file always aborts.
- Manual sync (ribbon icon / command), optional auto-sync every N minutes, optional sync on startup.
- **Dry run** command that prints the full sync plan to the developer console without changing anything.
- Works on mobile too (all HTTP goes through Obsidian's `requestUrl`, which bypasses CORS).

## Install

Not in the community plugin store. Install with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the **BRAT** plugin from the community store and enable it.
2. Command palette → **BRAT: Add a beta plugin for testing**.
3. Paste `Shidiq/obisidian-koofr-sync` (note the repo name spelling) and choose the latest version.
4. Enable **Koofr Sync** in Settings → Community plugins.

BRAT will pull new releases automatically. To update by hand: **BRAT: Check for updates to all beta plugins**.

Manual install instead: download `main.js` and `manifest.json` from the [latest release](https://github.com/Shidiq/obisidian-koofr-sync/releases/latest) into `<vault>/.obsidian/plugins/koofr-sync/`, then reload Obsidian.

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
2. Small text files → 3-way merge. Non-overlapping edits merge cleanly; overlapping edits produce git-style `<<<<<<< local / ======= / >>>>>>> remote` markers and a notification. With no cached base (first sync, or a cache that was cleared) the merge runs against an empty base, so a side that is empty loses cleanly instead of overwriting the other.
3. Binary or large files → both versions are kept, on both sides.

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

### Cutting a release

Releases are built by `.github/workflows/release.yml`: pushing a tag builds the plugin and publishes a GitHub release with `main.js`, `manifest.json`, and `versions.json` attached — the three files BRAT looks for.

The tag must match `manifest.json`'s version exactly, with no `v` prefix (the workflow fails otherwise):

```
# bump "version" in manifest.json and package.json, add the entry to versions.json
git commit -am "chore: release 0.1.2"
git tag 0.1.2
git push && git push --tags
```
