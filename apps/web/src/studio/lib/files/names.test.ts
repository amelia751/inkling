import { describe, expect, it } from "vitest";
import { copyName, extensionChanged, keepBothName, nameWarning, nextUntitled, normalizeName, stem, validateName, windowsReservedWarning } from "./names";

describe("names (todo7 D10)", () => {
  it("stems keep multi-part extensions together", () => {
    expect(stem("scan001.dcm")).toBe("scan001");
    expect(stem("t1.nii.gz")).toBe("t1");
    expect(stem("archive.tar.gz")).toBe("archive");
    expect(stem("README")).toBe("README");
    expect(stem(".env")).toBe(".env");
    expect(stem("a.b.c.csv")).toBe("a.b.c");
  });

  it("validates with one sentence per rule", () => {
    expect(validateName("", [])).toBe("Type a name");
    expect(validateName("   ", [])).toBe("Type a name");
    expect(validateName("..", [])).toMatch(/can't be used/);
    expect(validateName("a/b", [])).toBe("Names can't contain “/”");
    expect(validateName("a\u0007b", [])).toMatch(/control characters/);
    expect(validateName("é".repeat(128), [])).toMatch(/too long/);
    expect(validateName("é".repeat(127), [])).toBeNull();
    expect(validateName("MRI", ["mri", "CT"])).toBe("A folder named “mri” is already here");
    expect(validateName("Scan.DCM", ["scan.dcm"], { isFile: true })).toBe("A file named “scan.dcm” is already here");
    expect(validateName("fine", ["other"])).toBeNull();
  });

  it("lets a node keep its own name, and change its case", () => {
    expect(validateName("MRI", ["MRI", "CT"], { current: "MRI" })).toBeNull();
    expect(validateName("mri", ["MRI", "CT"], { current: "MRI" })).toBeNull();
    expect(validateName("ct", ["MRI", "CT"], { current: "MRI" })).toMatch(/already here/);
  });

  it("trims trailing spaces and dots", () => {
    expect(normalizeName("scan.dcm. . ")).toBe("scan.dcm");
    expect(validateName("MRI.  ", ["mri"])).toMatch(/already here/);
  });

  it("warns, never blocks, on Windows reserved names", () => {
    expect(windowsReservedWarning("CON")).toMatch(/reserved on Windows/);
    expect(windowsReservedWarning("nul.txt")).toMatch(/NUL/);
    expect(windowsReservedWarning("console")).toBeNull();
    expect(validateName("CON", [])).toBeNull();
  });

  it("notices extension changes", () => {
    expect(extensionChanged("scan.dcm", "scan2.dcm")).toBe(false);
    expect(extensionChanged("scan.dcm", "scan.DCM")).toBe(false);
    expect(extensionChanged("scan.dcm", "scan.png")).toBe(true);
    expect(extensionChanged("t1.nii.gz", "t2.nii.gz")).toBe(false);
    expect(extensionChanged("t1.nii.gz", "t1.nii")).toBe(true);
    expect(extensionChanged("notes", "notes.txt")).toBe(true);
  });

  it("numbers untitled folders", () => {
    expect(nextUntitled([])).toBe("Untitled folder");
    expect(nextUntitled(["untitled folder"])).toBe("Untitled folder 2");
    expect(nextUntitled(["Untitled folder", "Untitled folder 2", "Untitled folder 4"])).toBe("Untitled folder 3");
  });

  it("keeps both with (2), (3)…", () => {
    expect(keepBothName("scan001.dcm", ["scan001.dcm"])).toBe("scan001 (2).dcm");
    expect(keepBothName("scan001.dcm", ["scan001.dcm", "scan001 (2).dcm"])).toBe("scan001 (3).dcm");
    expect(keepBothName("scan001 (2).dcm", ["scan001 (2).dcm"])).toBe("scan001 (3).dcm");
    expect(keepBothName("t1.nii.gz", ["T1.nii.gz"])).toBe("t1 (2).nii.gz");
    expect(keepBothName("MRI", ["MRI"])).toBe("MRI (2)");
    expect(keepBothName("free.dcm", ["other.dcm"])).toBe("free.dcm");
  });

  it("names duplicates (copy)", () => {
    expect(copyName("scan.dcm")).toBe("scan (copy).dcm");
    expect(copyName("scan.dcm", ["scan (copy).dcm"])).toBe("scan (copy 2).dcm");
    expect(copyName("MRI")).toBe("MRI (copy)");
  });
});

describe("nameWarning (never blocks)", () => {
  it("warns about Windows-reserved names, with or without an extension", () => {
    expect(nameWarning("CON")).toMatch(/reserved on Windows/);
    expect(nameWarning("nul.txt", { isFile: true })).toMatch(/reserved on Windows/);
    expect(nameWarning("console")).toBeNull();
  });
  it("warns about names that look like a person's, like the server's privacy check", () => {
    expect(nameWarning("Smith_John_MRI.dcm", { isFile: true })).toMatch(/person's name/);
    expect(nameWarning("DOE^JANE")).toMatch(/person's name/);
    expect(nameWarning("Chest_Xray")).toBeNull();
    expect(nameWarning("case_014.dcm", { isFile: true })).toBeNull();
    expect(nameWarning("scan_2024-03-07")).toMatch(/date/);
  });
});
