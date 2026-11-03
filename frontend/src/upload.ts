// Collect audio files from a drop (folders included) or a directory picker, keeping their relative paths.

const AUDIO = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|opus|aiff?|wma)$/i;

export interface PickedFile {
  file: File;
  path: string;
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    if (AUDIO.test(file.name)) out.push({ file, path: prefix + file.name });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

export async function filesFromDrop(items: DataTransferItemList): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries = Array.from(items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  for (const entry of entries) await walk(entry, "", out);
  return out;
}

export function filesFromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? [])
    .filter((f) => AUDIO.test(f.name))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
