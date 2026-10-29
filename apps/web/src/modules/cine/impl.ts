import { legacyImpl } from "@/viewers/legacy";
import { cine4dAdapter } from "@/viewers/cine4d/adapter";

export default legacyImpl(cine4dAdapter, "slice-frame-canvas");
