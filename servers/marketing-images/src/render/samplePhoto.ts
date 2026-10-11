import sharp from 'sharp';

/**
 * A photo-like picture generated locally (soft gradient, a bright "sun", dark "hills", light deterministic grain) used for
 * catalog previews of the built-in templates, so no network is needed and the previews are always the same.
 */
export async function samplePhoto(width = 1600, height = 1600): Promise<Buffer> {
  const blur = (id: string, sigma: number): string => `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${Math.round(sigma)}"/></filter>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9d5a1"/><stop offset="0.5" stop-color="#c9a27a"/><stop offset="1" stop-color="#6b8f71"/></linearGradient>
      ${blur('b1', height * 0.05)}${blur('b2', height * 0.09)}
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.72}" cy="${height * 0.28}" r="${height * 0.2}" fill="#fff1c9" filter="url(#b1)"/>
    <ellipse cx="${width * 0.25}" cy="${height * 0.82}" rx="${width * 0.5}" ry="${height * 0.2}" fill="#3f5a4a" opacity="0.75" filter="url(#b2)"/>
    <ellipse cx="${width * 0.82}" cy="${height * 0.92}" rx="${width * 0.45}" ry="${height * 0.18}" fill="#2f4a5c" opacity="0.65" filter="url(#b2)"/>
  </svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let seed = 20261011;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = Math.max(0, Math.min(255, (data[i] as number) + ((seed >>> 24) % 9) - 4));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}
