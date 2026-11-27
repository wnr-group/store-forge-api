/**
 * Spreadsheet safety for exported and imported text cells.
 *
 * A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is run as a formula by Excel and friends
 * ("CSV / formula injection"). The backend hands the rows to the frontend, which writes the file, so every text value that
 * could be read that way leaves with one leading apostrophe (the spreadsheet convention for "this is text"). When the same
 * file comes back, a leading apostrophe followed by such a character is taken off again, so export -> import is lossless.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function unescapeCell(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1))
    ? value.slice(1)
    : value;
}
