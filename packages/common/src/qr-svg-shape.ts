/**
 * Exact shape of the QR SVG that Finance renders: one white background rect and one black path of
 * run-length merged modules, no scripts, text, links or external references. The Gateway refuses
 * anything else before a client embeds it.
 */
export const QR_SVG_SHAPE =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" shape-rendering="crispEdges" role="img" aria-label="[A-Za-z0-9 ]*"><rect width="\d+" height="\d+" fill="#ffffff"\/><path d="(?:M\d+ \d+h\d+v1h-\d+z)+" fill="#000000"\/><\/svg>$/;
export const QR_SVG_MAX_BYTES = 65536;
