/**
 * ECG vocabularies: WFDB annotation codes (ecgcodes.h / annot.c mnemonics), WFDB rhythm
 * aux strings, and record-level statements with their SNOMED CT codes (PhysioNet/CinC 2020
 * scored set, which is how the PTB-XL "HR" records list their Dx).
 *
 * Self-contained (no imports) so node self-tests can load it with --experimental-strip-types.
 */

export const STANDARD_LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"];

/** WFDB annotation code → mnemonic (ecgcodes.h; annstr[] in lib/annot.c). */
export const WFDB_CODES: { code: number; symbol: string; name: string; beat?: boolean }[] = [
  { code: 1, symbol: "N", name: "Normal beat", beat: true },
  { code: 2, symbol: "L", name: "Left bundle branch block beat", beat: true },
  { code: 3, symbol: "R", name: "Right bundle branch block beat", beat: true },
  { code: 4, symbol: "a", name: "Aberrated atrial premature beat", beat: true },
  { code: 5, symbol: "V", name: "Premature ventricular contraction", beat: true },
  { code: 6, symbol: "F", name: "Fusion of ventricular and normal beat", beat: true },
  { code: 7, symbol: "J", name: "Nodal (junctional) premature beat", beat: true },
  { code: 8, symbol: "A", name: "Atrial premature beat", beat: true },
  { code: 9, symbol: "S", name: "Supraventricular premature beat", beat: true },
  { code: 10, symbol: "E", name: "Ventricular escape beat", beat: true },
  { code: 11, symbol: "j", name: "Nodal (junctional) escape beat", beat: true },
  { code: 12, symbol: "/", name: "Paced beat", beat: true },
  { code: 13, symbol: "Q", name: "Unclassifiable beat", beat: true },
  { code: 14, symbol: "~", name: "Signal quality change" },
  { code: 16, symbol: "|", name: "Isolated QRS-like artifact" },
  { code: 18, symbol: "s", name: "ST change" },
  { code: 19, symbol: "T", name: "T-wave change" },
  { code: 20, symbol: "*", name: "Systole" },
  { code: 21, symbol: "D", name: "Diastole" },
  { code: 22, symbol: '"', name: "Comment" },
  { code: 23, symbol: "=", name: "Measurement" },
  { code: 24, symbol: "p", name: "P-wave peak" },
  { code: 25, symbol: "B", name: "Bundle branch block beat (unspecified)", beat: true },
  { code: 26, symbol: "^", name: "Non-conducted pacer spike" },
  { code: 27, symbol: "t", name: "T-wave peak" },
  { code: 28, symbol: "+", name: "Rhythm change" },
  { code: 29, symbol: "u", name: "U-wave peak" },
  { code: 30, symbol: "?", name: "Learning" },
  { code: 31, symbol: "!", name: "Ventricular flutter wave", beat: true },
  { code: 32, symbol: "[", name: "Start of ventricular flutter/fibrillation" },
  { code: 33, symbol: "]", name: "End of ventricular flutter/fibrillation" },
  { code: 34, symbol: "e", name: "Atrial escape beat", beat: true },
  { code: 35, symbol: "n", name: "Supraventricular escape beat", beat: true },
  { code: 36, symbol: "@", name: "Link to external data" },
  { code: 37, symbol: "x", name: "Non-conducted P-wave (blocked APC)" },
  { code: 38, symbol: "f", name: "Fusion of paced and normal beat", beat: true },
  { code: 39, symbol: "(", name: "Waveform onset" },
  { code: 40, symbol: ")", name: "Waveform end" },
  { code: 41, symbol: "r", name: "R-on-T premature ventricular contraction", beat: true },
];

export const WFDB_CODE_BY_SYMBOL = new Map(WFDB_CODES.map((c) => [c.symbol, c]));

/** Beat codes offered in the viewer's code picker, in the order an annotator reaches for them. */
export const BEAT_CODES = ["N", "V", "A", "L", "R", "F", "J", "S", "E", "/", "f", "Q", "a", "j", "e", "n", "r", "B", "!"];

/** Codes that Shift+letter assigns (Shift+N → N, Shift+V → V …). Lower-case codes are picker-only. */
export const SHIFT_BEAT_CODES = new Set(["N", "V", "A", "L", "R", "F", "J", "S", "E", "Q", "B"]);

export function beatCodeName(symbol: string): string {
  return WFDB_CODE_BY_SYMBOL.get(symbol)?.name ?? symbol;
}

/** WFDB rhythm aux strings (MIT-BIH conventions). */
export const RHYTHMS: { aux: string; name: string }[] = [
  { aux: "(N", name: "Normal sinus rhythm" },
  { aux: "(SBR", name: "Sinus bradycardia" },
  { aux: "(AFIB", name: "Atrial fibrillation" },
  { aux: "(AFL", name: "Atrial flutter" },
  { aux: "(SVTA", name: "Supraventricular tachyarrhythmia" },
  { aux: "(VT", name: "Ventricular tachycardia" },
  { aux: "(B", name: "Ventricular bigeminy" },
  { aux: "(T", name: "Ventricular trigeminy" },
  { aux: "(IVR", name: "Idioventricular rhythm" },
  { aux: "(NOD", name: "Nodal (junctional) rhythm" },
  { aux: "(P", name: "Paced rhythm" },
  { aux: "(BII", name: "2° heart block" },
  { aux: "(PREX", name: "Pre-excitation (WPW)" },
  { aux: "(AB", name: "Atrial bigeminy" },
  { aux: "(VFL", name: "Ventricular flutter" },
];

export function rhythmName(aux: string): string {
  return RHYTHMS.find((r) => r.aux === aux)?.name ?? aux;
}

/** Record-level diagnostic statements (SNOMED CT, PhysioNet/CinC 2020 scored set + PTB-XL extras). */
export const STATEMENTS: { snomed: string; abbr: string; name: string }[] = [
  { snomed: "426783006", abbr: "SNR", name: "Sinus rhythm" },
  { snomed: "426177001", abbr: "SB", name: "Sinus bradycardia" },
  { snomed: "427084000", abbr: "STach", name: "Sinus tachycardia" },
  { snomed: "427393009", abbr: "SA", name: "Sinus arrhythmia" },
  { snomed: "164889003", abbr: "AF", name: "Atrial fibrillation" },
  { snomed: "164890007", abbr: "AFL", name: "Atrial flutter" },
  { snomed: "270492004", abbr: "IAVB", name: "1st degree AV block" },
  { snomed: "164947007", abbr: "LPR", name: "Prolonged PR interval" },
  { snomed: "164909002", abbr: "LBBB", name: "Left bundle branch block" },
  { snomed: "59118001", abbr: "RBBB", name: "Right bundle branch block" },
  { snomed: "713426002", abbr: "IRBBB", name: "Incomplete RBBB" },
  { snomed: "445118002", abbr: "LAnFB", name: "Left anterior fascicular block" },
  { snomed: "698252002", abbr: "NSIVCB", name: "Nonspecific IV conduction disturbance" },
  { snomed: "39732003", abbr: "LAD", name: "Left axis deviation" },
  { snomed: "47665007", abbr: "RAD", name: "Right axis deviation" },
  { snomed: "251146004", abbr: "LQRSV", name: "Low QRS voltages" },
  { snomed: "164873001", abbr: "LVH", name: "Left ventricular hypertrophy" },
  { snomed: "164865005", abbr: "MI", name: "Myocardial infarction" },
  { snomed: "164951009", abbr: "abQRS", name: "Abnormal QRS" },
  { snomed: "164917005", abbr: "QAb", name: "Q wave abnormal" },
  { snomed: "164934002", abbr: "TAb", name: "T wave abnormal" },
  { snomed: "59931005", abbr: "TInv", name: "T wave inversion" },
  { snomed: "428750005", abbr: "NSSTTA", name: "Nonspecific ST-T abnormality" },
  { snomed: "111975006", abbr: "LQT", name: "Prolonged QT interval" },
  { snomed: "284470004", abbr: "PAC", name: "Premature atrial contraction" },
  { snomed: "427172004", abbr: "PVC", name: "Premature ventricular contractions" },
  { snomed: "10370003", abbr: "PR", name: "Pacing rhythm" },
];

export function statementForCode(snomed: string) {
  return STATEMENTS.find((s) => s.snomed === snomed);
}

/** Map a project label to the LUDB wave kind it delineates. */
export function waveKindForLabel(label: string | null | undefined): "P" | "QRS" | "T" | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/\bqrs\b/.test(l)) return "QRS";
  if (/^p\b|p wave|p-wave/.test(l)) return "P";
  if (/^t\b|t wave|t-wave/.test(l)) return "T";
  return null;
}

/** The project label that names a wave kind, if the project has one. */
export function labelForWave(labels: string[], wave: "P" | "QRS" | "T"): string | undefined {
  return labels.find((l) => waveKindForLabel(l) === wave);
}
