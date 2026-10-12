import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserFacingError } from './errors.js';
import { sniffFormat, type FetchKind } from './fetchsafe.js';

/**
 * Local files for stdio mode. In that mode the tools hand out `file://` URLs for the images they make, and the
 * agent gives them back (as `background.image_url`, `edit_image.image_url`, brand logos...). Those references are
 * read from disk here instead of being downloaded.
 *
 * Only `file://` URLs inside an allow-list of folders are read: the folder where this server stores its own images,
 * plus the folders the owner lists in `LOCAL_IMAGE_DIRS`. Real paths are compared (symlinks are resolved), the file
 * must be a regular file within the size limit, and its first bytes must be an image (or a TTF/OTF font), exactly
 * like a download. HTTP mode never has a `LocalFiles`: `file://` links are refused there.
 */

export interface LocalFiles {
  /** True for `file:` references (the caller must then use `read` instead of a download). */
  isLocalRef(ref: string): boolean;
  read(ref: string, options: { kind: FetchKind; allowSvg?: boolean; maxBytes?: number }): Promise<Buffer>;
}

export const LOCAL_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const LOCAL_MAX_FONT_BYTES = 8 * 1024 * 1024;

export function createLocalFiles(options: { roots: readonly string[] }): LocalFiles {
  const roots = options.roots.map((r) => path.resolve(r));

  const notAllowed = (): UserFacingError =>
    new UserFacingError(
      'local_file_not_allowed',
      'That local file is outside the folders this server may read.',
      'Use the `url` of an image this server made, or ask the user to add the folder to LOCAL_IMAGE_DIRS. A public https link also works.',
    );

  async function insideRoots(real: string): Promise<boolean> {
    for (const root of roots) {
      try {
        const realRoot = await realpath(root);
        if (real.startsWith(realRoot + path.sep)) return true;
      } catch {
        // A root that does not exist yet contains nothing.
      }
    }
    return false;
  }

  return {
    isLocalRef: (ref) => /^file:/i.test(ref),

    async read(ref, opts) {
      let file: string;
      try {
        file = fileURLToPath(ref);
      } catch {
        throw new UserFacingError('url_invalid', 'That is not a valid local file link.', 'Use the `url` returned by the tool that made the image.');
      }
      if (!path.isAbsolute(file)) throw new UserFacingError('url_invalid', 'That is not a valid local file link.');

      let real: string;
      try {
        real = await realpath(file);
      } catch {
        // Missing files and files outside the allow-list answer alike, so paths elsewhere on disk cannot be probed.
        if (!(await insideRoots(path.resolve(file)))) throw notAllowed();
        throw new UserFacingError('local_file_missing', 'That local file does not exist (images are deleted after RETENTION_DAYS).', 'Make the image again.');
      }
      if (!(await insideRoots(real))) throw notAllowed();

      const maxBytes = opts.maxBytes ?? (opts.kind === 'font' ? LOCAL_MAX_FONT_BYTES : LOCAL_MAX_IMAGE_BYTES);
      const info = await stat(real);
      if (!info.isFile()) throw notAllowed();
      if (info.size > maxBytes) {
        throw new UserFacingError('file_too_large', `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'Use a smaller version (a normal social-media size is plenty).');
      }
      const data = await readFile(real);
      if (!sniffFormat(data, opts.kind, opts.allowSvg === true)) {
        throw opts.kind === 'font'
          ? new UserFacingError('font_unsupported', 'That file is not a TTF or OTF font.', 'Use a .ttf or .otf file.')
          : new UserFacingError('not_an_image', 'That file is not a supported image (JPEG, PNG, WebP or AVIF).', 'SVG and GIF are not supported.');
      }
      return data;
    },
  };
}
