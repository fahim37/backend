const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** RFC 4180 field escaping with protection against spreadsheet formula injection. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/** CSV document with a UTF-8 BOM so spreadsheet apps detect the encoding. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return `﻿${[csvRow(header), ...rows.map(csvRow)].join("\r\n")}\r\n`;
}
