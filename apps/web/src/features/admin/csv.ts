/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ImportRow = { email: string; firstName: string; lastName: string };
export type ImportParse = { rows: ImportRow[]; errors: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parses `email,firstName,lastName` rows. A header row is detected and may list
 * the columns in any order. Duplicate emails and invalid rows are reported.
 */
export function parseUserCsv(text: string, max = 1000): ImportParse {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (!table.length) return { rows: [], errors: ["The file is empty"] };
  let idx = { email: 0, firstName: 1, lastName: 2 };
  let start = 0;
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/[\s_]/g, ""));
  if (header.includes("email")) {
    const find = (...names: string[]) => header.findIndex((h) => names.includes(h));
    idx = { email: find("email"), firstName: find("firstname", "first", "givenname"), lastName: find("lastname", "last", "surname", "familyname") };
    if (idx.firstName < 0 || idx.lastName < 0) return { rows: [], errors: ["Header must contain email, firstName and lastName"] };
    start = 1;
  }
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (let i = start; i < table.length; i++) {
    const r = table[i]!;
    const email = (r[idx.email] ?? "").trim().toLowerCase();
    const firstName = (r[idx.firstName] ?? "").trim();
    const lastName = (r[idx.lastName] ?? "").trim();
    const line = i + 1;
    if (!EMAIL.test(email)) errors.push(`Line ${line}: invalid email "${email}"`);
    else if (!firstName || !lastName) errors.push(`Line ${line}: first and last name are required`);
    else if (firstName.length > 100 || lastName.length > 100) errors.push(`Line ${line}: names must be at most 100 characters`);
    else if (seen.has(email)) errors.push(`Line ${line}: duplicate email ${email}`);
    else {
      seen.add(email);
      rows.push({ email, firstName, lastName });
    }
  }
  if (rows.length > max) {
    errors.push(`Only the first ${max} rows can be imported at once`);
    rows.length = max;
  }
  return { rows, errors };
}
