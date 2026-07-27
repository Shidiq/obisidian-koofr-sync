import { mergeDiff3 } from "node-diff3";

export interface MergeOutcome {
  clean: boolean;
  text: string;
}

/**
 * Three-way merge of local vs remote with the last-synced base.
 * Clean merge → merged text. Overlapping edits → git-style conflict markers
 * (<<<<<<< local / ||||||| base / ======= / >>>>>>> remote).
 */
export function threeWayMerge(localText: string, baseText: string, remoteText: string): MergeOutcome {
  const res = mergeDiff3(splitLines(localText), splitLines(baseText), splitLines(remoteText), {
    excludeFalseConflicts: true,
    label: { a: "local", o: "base", b: "remote" },
  });
  return { clean: !res.conflict, text: res.result.join("\n") };
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

export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}
