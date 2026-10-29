import { legacyImpl } from "@/viewers/legacy";
import { pathologyAdapter } from "@/viewers/pathology/adapter";

export default legacyImpl(pathologyAdapter, "osd");
