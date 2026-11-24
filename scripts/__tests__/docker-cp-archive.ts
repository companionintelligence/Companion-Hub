/**
 * The tar archive `docker cp <container>:<dir> -` streams for a folder: a header block for the folder,
 * then one per file followed by its data padded to 512 bytes, ended by two zero blocks. Tests hand it
 * back from a mocked `docker cp` to stand in for the copy route in scripts/lib/docker-exec-output.ts.
 */
export function dockerCpArchive(dir: string, files: Record<string, string>): Buffer {
  const header = (name: string, size: number, type: string) => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 'utf-8');
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    block.write(type, 156, 'ascii');
    block.write('ustar\0', 257, 'ascii');
    return block;
  };
  const blocks = [header(`${dir}/`, 0, '5')];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf-8');
    blocks.push(header(`${dir}/${name}`, body.length, '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The folder the copy route leaves for a command that printed `out` and exited with `status`. */
export function copiedCommandFolder(dir: string, out: string, status = 0): Buffer {
  return dockerCpArchive(dir, { out, err: '', status: `${status}\n` });
}
