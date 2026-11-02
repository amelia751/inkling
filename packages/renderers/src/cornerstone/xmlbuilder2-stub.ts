import { NAMING } from "@studio/contracts/naming";
/**
 * Stand-in for `xmlbuilder2`, which vtk.js's XML (VTP) reader/writer imports and which
 * needs Node's `events` module (Vite externalizes it, so the class extends `undefined`
 * and crashes at import time). We never read or writes VTK XML files.
 */
export function create(): never {
  throw new Error(`VTK XML files are not supported in ${NAMING.displayName}`);
}

export default { create };
