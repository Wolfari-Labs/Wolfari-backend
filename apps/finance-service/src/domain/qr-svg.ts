import { create } from 'qrcode';

/**
 * Renders a QR symbol as a minimal self-contained SVG: one background rect and one path of
 * run-length merged dark modules, with the 4-module quiet zone the QR standard requires.
 * No scripts, links, text or external references, so clients may embed it directly.
 */
export function renderQrSvg(text: string, label = 'QR'): string {
  const symbol = create(text, { errorCorrectionLevel: 'M' });
  const size = symbol.modules.size;
  const data = symbol.modules.data;
  const quiet = 4;
  const total = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && data[y * size + x + run]) run++;
      path += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const safeLabel = label.replace(/[^A-Za-z0-9 ]/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${safeLabel}">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}

export { QR_SVG_SHAPE } from '@wolfari/common';
