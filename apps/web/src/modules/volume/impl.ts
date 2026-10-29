import { legacyImpl } from "@/viewers/legacy";
import { volume3dAdapter } from "@/viewers/volume3d/adapter";

export default legacyImpl(volume3dAdapter, "cornerstone-mpr");
