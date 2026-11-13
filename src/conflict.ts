import { diff3Merge, mergeDiff3 } from "node-diff3";

export interface MergeOutcome {
  clean: boolean;
  text: string;
}

export type MergeStyle = "markers" | "mdFence";

// node-diff3 ships `any` types for diff3Merge; the actual chunk shape:
type Diff3Chunk =
  | { ok: string[] }
  | { conflict: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number } };

/**
 * Three-way merge of local vs remote with the last-synced base.
 * Clean merge → merged text. Overlapping edits:
 * - "markers": git-style conflict markers (<<<<<<< local / ||||||| base / ======= / >>>>>>> remote)
 * - "mdFence": local lines stay inline, remote version follows in a ```new fenced block
 */
export function threeWayMerge(
  localText: string,
  baseText: string,
  remoteText: string,
  style: MergeStyle = "markers"
): MergeOutcome {
  const local = splitLines(localText);
  const base = splitLines(baseText);
  const remote = splitLines(remoteText);

  if (style === "markers") {
    const res = mergeDiff3(local, base, remote, {
      excludeFalseConflicts: true,
      label: { a: "local", o: "base", b: "remote" },
    });
    return { clean: !res.conflict, text: res.result.join("\n") };
  }

  const chunks = diff3Merge(local, base, remote, { excludeFalseConflicts: true }) as Diff3Chunk[];
  const out: string[] = [];
  let clean = true;
  for (const chunk of chunks) {
    if ("ok" in chunk) {
      out.push(...chunk.ok);
      continue;
    }
    clean = false;
    const { a, b } = chunk.conflict;
    out.push(...a);
    if (a.length > 0 && a[a.length - 1] !== "") out.push("");
    const fence = fenceFor(b);
    out.push(fence + "new");
    out.push(...b);
    out.push(fence);
  }
  return { clean, text: out.join("\n") };
}

/** Fence longer than any backtick fence opener inside the content (markdown fences may be indented up to 3 spaces). */
function fenceFor(lines: string[]): string {
  let longest = 0;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,})/.exec(line);
    if (m && m[1].length > longest) longest = m[1].length;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function splitLines(s: string): string[] {
  return s.split(/\r\n|\r|\n/);
}

/** "notes/idea.md" → "notes/idea (conflict 2026-07-27 1532).md" (counter suffix if taken). */
export function conflictCopyName(path: string, when: Date, exists: (p: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";

  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(
    when.getHours()
  )}${pad(when.getMinutes())}`;

  let candidate = `${dir}${stem} (conflict ${stamp})${ext}`;
  let counter = 2;
  while (exists(candidate)) {
    candidate = `${dir}${stem} (conflict ${stamp} ${counter})${ext}`;
    counter++;
  }
  return candidate;
}

/**
 * A conflict where one side is a 0-byte file: keep the side with content.
 * Nothing is lost, since the empty side has none. This also covers the remote
 * file a failed PUT leaves behind (Koofr truncates before storing the body),
 * which would otherwise be merged in as "remote deleted everything".
 */
export function emptySideWinner(localLen: number, remoteLen: number): "local" | "remote" | null {
  if (localLen > 0 && remoteLen === 0) return "local";
  if (localLen === 0 && remoteLen > 0) return "remote";
  return null;
}

export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}
