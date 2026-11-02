import { describe, expect, it } from "vitest";
import { isJunk } from "./walk";

describe("todo18 junk files are never uploaded", () => {
  it.each(["a/.git/HEAD", ".git/objects/ab/cd", "x/Thumbs.db", "desktop.ini", "a/__MACOSX/b.png", "._x.png", ".DS_Store"])("%s is junk", (p) => expect(isJunk(p)).toBe(true));
  it.each(["a/b.png", "git/notes.txt", "a.gitignore"])("%s is kept", (p) => expect(isJunk(p)).toBe(false));
});
