/**
 * Stand-in for `xmlbuilder2`, which vtk.js's XML (VTP) reader/writer imports and which
 * needs Node's `events` module (Vite externalizes it, so the class extends `undefined`
 * and crashes at import time). Inkling never reads or writes VTK XML files.
 */
export function create(): never {
  throw new Error("VTK XML files are not supported in Inkling");
}

export default { create };
