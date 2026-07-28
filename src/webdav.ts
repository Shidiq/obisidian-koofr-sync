import { requestUrl, RequestUrlResponse } from "obsidian";
import { RemoteEntry } from "./types";
import { pLimit } from "./concurrency";

export class WebDavError extends Error {
  constructor(message: string, public status: number | null, public path?: string) {
    super(message);
    this.name = "WebDavError";
  }
}

/**
 * Statuses worth retrying. 423 is the important one on Koofr: it locks a folder for
 * the duration of a write, so parallel writes into one folder get "Locked" back.
 */
const RETRY_STATUSES = new Set([423, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getetag/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

/** Parent folder of a vault-relative path; "" means the remote base dir itself. */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function encodeSegments(path: string): string {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function statusMessage(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Authentication failed — check username and app password";
    case 404:
      return "Not found";
    case 423:
      return "Resource is locked on the server";
    case 507:
      return "Server storage quota exceeded";
    default:
      return `Server returned HTTP ${status}`;
  }
}

/** Server bodies carry the real reason; keep a short slice of it in the error. */
function bodySnippet(resp: RequestUrlResponse): string {
  let text = "";
  try {
    text = (resp.text ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
  if (!text) return "";
  return ` — ${text.length > 200 ? text.slice(0, 200) + "…" : text}`;
}

function davError(method: string, resp: RequestUrlResponse, path: string): WebDavError {
  return new WebDavError(
    `${method} ${path || "/"} failed: ${statusMessage(resp.status)} (HTTP ${resp.status})${bodySnippet(resp)}`,
    resp.status,
    path
  );
}

export interface ConnectivityResult {
  ok: boolean;
  message: string;
}

export class WebDavClient {
  private baseUrl: string; // full URL to the remote base dir, no trailing slash
  private basePathPrefix: string; // decoded pathname of baseUrl, used to strip hrefs
  private authHeader: string;
  private knownDirs = new Map<string, Promise<void>>();
  // One in-flight write per remote folder — Koofr locks the folder while writing.
  private dirLocks = new Map<string, Promise<unknown>>();

  constructor(webdavUrl: string, username: string, password: string, remoteBaseDir: string) {
    const root = webdavUrl.replace(/\/+$/, "");
    const baseDirPart = encodeSegments(remoteBaseDir);
    this.baseUrl = baseDirPart ? `${root}/${baseDirPart}` : root;
    // btoa(unescape(encodeURIComponent(...))) handles non-ASCII credentials
    this.authHeader = "Basic " + btoa(unescape(encodeURIComponent(`${username}:${password}`)));
    const u = new URL(this.baseUrl);
    this.basePathPrefix = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  }

  private urlFor(path: string, isDir = false): string {
    const enc = encodeSegments(path);
    if (!enc) return this.baseUrl + (isDir ? "/" : "");
    return `${this.baseUrl}/${enc}${isDir ? "/" : ""}`;
  }

  /**
   * One request, retried on transient failures (locked folder, throttling, 5xx,
   * network errors). All verbs used here are idempotent, so replaying is safe.
   */
  private async request(
    method: string,
    url: string,
    extraHeaders: Record<string, string> = {},
    body?: string | ArrayBuffer,
    attempts = MAX_ATTEMPTS
  ): Promise<RequestUrlResponse> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let resp: RequestUrlResponse;
      try {
        resp = await requestUrl({
          url,
          method,
          headers: { Authorization: this.authHeader, ...extraHeaders },
          body,
          throw: false,
        });
      } catch (e) {
        lastError = e;
        if (attempt === attempts) break;
        await sleep(this.backoff(attempt));
        continue;
      }
      if (!RETRY_STATUSES.has(resp.status) || attempt === attempts) return resp;
      await sleep(this.backoff(attempt));
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Network error: ${String(lastError)}`);
  }

  /** Exponential backoff with jitter, so retries from parallel tasks spread out. */
  private backoff(attempt: number): number {
    return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
  }

  /**
   * Serialize writes that touch the same remote folder. Different folders still run
   * in parallel, so overall concurrency is preserved.
   */
  private withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.dirLocks.get(dir) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.dirLocks.set(dir, settled);
    return run;
  }

  /** Convert a multistatus href into a vault-relative path ("" = the base dir itself). */
  private hrefToRelPath(href: string): string | null {
    let pathname = href;
    if (/^https?:\/\//i.test(href)) {
      try {
        pathname = new URL(href).pathname;
      } catch {
        return null;
      }
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    decoded = decoded.replace(/\/+$/, "");
    if (decoded === this.basePathPrefix) return "";
    if (!decoded.startsWith(this.basePathPrefix + "/")) return null;
    return decoded.slice(this.basePathPrefix.length + 1);
  }

  private parseMultistatus(xml: string): RemoteEntry[] {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const responses = doc.getElementsByTagNameNS("DAV:", "response");
    const entries: RemoteEntry[] = [];
    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const hrefEl = resp.getElementsByTagNameNS("DAV:", "href")[0];
      if (!hrefEl || !hrefEl.textContent) continue;
      const relPath = this.hrefToRelPath(hrefEl.textContent.trim());
      if (relPath === null) continue;

      const isDir = resp.getElementsByTagNameNS("DAV:", "collection").length > 0;
      const lenEl = resp.getElementsByTagNameNS("DAV:", "getcontentlength")[0];
      const etagEl = resp.getElementsByTagNameNS("DAV:", "getetag")[0];
      const modEl = resp.getElementsByTagNameNS("DAV:", "getlastmodified")[0];

      let etag: string | null = null;
      if (etagEl && etagEl.textContent) {
        etag = etagEl.textContent.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
      }
      let mtime: number | null = null;
      if (modEl && modEl.textContent) {
        const t = Date.parse(modEl.textContent.trim());
        if (!isNaN(t)) mtime = t;
      }

      entries.push({
        path: relPath,
        isDir,
        size: lenEl && lenEl.textContent ? parseInt(lenEl.textContent, 10) || 0 : 0,
        etag,
        mtime,
      });
    }
    return entries;
  }

  /** PROPFIND Depth 0 on the base dir — used by the "Check connectivity" button. */
  async check(): Promise<ConnectivityResult> {
    let resp: RequestUrlResponse;
    try {
      resp = await this.request("PROPFIND", this.baseUrl, {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      }, PROPFIND_BODY);
    } catch (e) {
      return { ok: false, message: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (resp.status === 207 || resp.status === 200) {
      return { ok: true, message: "Connected — WebDAV server and credentials are working." };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, message: "Authentication failed — check your username and app password." };
    }
    if (resp.status === 404) {
      return {
        ok: true,
        message: "Server and credentials OK. Remote base folder does not exist yet — it will be created on first sync.",
      };
    }
    return { ok: false, message: statusMessage(resp.status) };
  }

  /** PROPFIND Depth 1 on a directory. Returns children only (self entry removed). */
  async listDir(dirPath: string): Promise<RemoteEntry[]> {
    const resp = await this.request("PROPFIND", this.urlFor(dirPath, true), {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    }, PROPFIND_BODY);
    if (resp.status === 404) throw new WebDavError("Not found", 404, dirPath);
    if (resp.status !== 207) throw davError("PROPFIND", resp, dirPath);
    const self = dirPath.replace(/\/+$/, "");
    return this.parseMultistatus(resp.text).filter((e) => e.path !== self);
  }

  /**
   * Recursively list all files under the base dir (Depth-1 walks, bounded concurrency).
   * A 404 on the base dir itself is treated as an empty remote.
   */
  async walk(concurrency: number): Promise<RemoteEntry[]> {
    const files: RemoteEntry[] = [];
    const limit = pLimit(Math.max(1, concurrency));

    const visit = async (dir: string): Promise<void> => {
      const children = await limit(() => this.listDir(dir));
      const subdirs: string[] = [];
      for (const c of children) {
        if (c.isDir) subdirs.push(c.path);
        else files.push(c);
      }
      await Promise.all(subdirs.map((d) => visit(d)));
    };

    try {
      await visit("");
    } catch (e) {
      if (e instanceof WebDavError && e.status === 404 && (e.path === "" || e.path === undefined)) {
        return []; // base dir missing — empty remote
      }
      throw e;
    }
    return files;
  }

  async getFile(path: string): Promise<ArrayBuffer> {
    const resp = await this.request("GET", this.urlFor(path));
    if (resp.status >= 200 && resp.status < 300) return resp.arrayBuffer;
    throw davError("GET", resp, path);
  }

  async putFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.mkcolForFile(path);
    await this.withDirLock(parentDir(path), async () => {
      const resp = await this.request("PUT", this.urlFor(path), {
        "Content-Type": "application/octet-stream",
      }, data);
      if (resp.status < 200 || resp.status >= 300) throw davError("PUT", resp, path);
    });
  }

  async deleteFile(path: string): Promise<void> {
    await this.withDirLock(parentDir(path), async () => {
      const resp = await this.request("DELETE", this.urlFor(path));
      // 404 = already gone, which is what we wanted
      if (resp.status !== 404 && (resp.status < 200 || resp.status >= 300)) {
        throw davError("DELETE", resp, path);
      }
    });
  }

  /** PROPFIND Depth 0 on a single file — used to capture the fresh etag after PUT. */
  async statFile(path: string): Promise<RemoteEntry | null> {
    const resp = await this.request("PROPFIND", this.urlFor(path), {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    }, PROPFIND_BODY);
    if (resp.status === 404) return null;
    if (resp.status !== 207) throw davError("PROPFIND", resp, path);
    const entries = this.parseMultistatus(resp.text);
    return entries.length > 0 ? entries[0] : null;
  }

  /**
   * Ensure every parent collection of `filePath` exists. Each MKCOL is memoized as a
   * promise, so parallel uploads into one folder await a single MKCOL instead of
   * firing duplicates the server would answer with a lock error.
   */
  private async mkcolForFile(filePath: string): Promise<void> {
    const parts = filePath.split("/").filter((s) => s.length > 0);
    parts.pop(); // drop file name
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      let pending = this.knownDirs.get(current);
      if (!pending) {
        const dir = current;
        // MKCOL writes into the *parent*, so it takes the parent's lock.
        pending = this.withDirLock(parentDir(dir), () => this.mkcol(dir));
        this.knownDirs.set(dir, pending);
        // A failed MKCOL must not be cached as done.
        pending.catch(() => this.knownDirs.delete(dir));
      }
      await pending;
    }
  }

  /** Create the remote base dir chain itself (used on first sync). */
  async ensureBaseDir(): Promise<void> {
    const resp = await this.request("MKCOL", this.baseUrl + "/");
    if (![201, 200, 405, 301].includes(resp.status)) throw davError("MKCOL", resp, "");
  }

  private async mkcol(dirPath: string): Promise<void> {
    const resp = await this.request("MKCOL", this.urlFor(dirPath, true));
    // 405 = already exists; 409 = parent missing (shouldn't happen given the ordered chain)
    if (![201, 200, 405].includes(resp.status)) throw davError("MKCOL", resp, dirPath);
  }

  /** Called at the start of each sync run so stale dir knowledge doesn't linger. */
  resetDirCache(): void {
    this.knownDirs.clear();
    this.dirLocks.clear();
  }
}
