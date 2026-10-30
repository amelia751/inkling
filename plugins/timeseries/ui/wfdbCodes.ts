import * as z from "zod";

/**
 * The WFDB annotation mnemonics (ecgcodes.h; annstr[] in lib/annot.c): the MIT file format's
 * own code table, mapping a stored code (attributes.code) to the number written in a .atr.
 * Config default of the `wfdb-atr` exporter; codes without an entry are written as Q (13).
 */
export const WFDB_MNEMONICS: Record<string, number> = { "N": 1, "L": 2, "R": 3, "a": 4, "V": 5, "F": 6, "J": 7, "A": 8, "S": 9, "E": 10, "j": 11, "/": 12, "Q": 13, "~": 14, "|": 16, "s": 18, "T": 19, "*": 20, "D": 21, "\"": 22, "=": 23, "p": 24, "B": 25, "^": 26, "t": 27, "+": 28, "u": 29, "?": 30, "!": 31, "[": 32, "]": 33, "e": 34, "n": 35, "@": 36, "x": 37, "f": 38, "(": 39, ")": 40, "r": 41 };

export const WfdbExportConfigSchema = z.object({
  codes: z.record(z.string(), z.number().int().min(1).max(49)).default(WFDB_MNEMONICS).describe("Code → WFDB annotation number (ecgcodes.h)"),
  noise: z.string().default("artifact|artefact|noise").describe("Regular expression (case-insensitive) on the label of intervals written as NOISE (~) episodes"),
});
