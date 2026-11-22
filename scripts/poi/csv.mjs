// Minimal RFC 4180 CSV helpers for the POI golden list (no dependency).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) throw new Error('CSV: empty file');
  const header = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  const records = rows.slice(1).map((cells, index) => {
    if (cells.length !== header.length)
      throw new Error(
        `CSV: line ${index + 2} has ${cells.length} cells, expected ${header.length}`,
      );
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  return { header, records };
}

function cell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(header, records) {
  return `${[header.join(','), ...records.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n')}\n`;
}
