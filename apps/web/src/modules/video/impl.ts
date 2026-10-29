import { legacyImpl } from "@/viewers/legacy";
import { videoAdapter } from "@/viewers/video/adapter";

export default legacyImpl(videoAdapter, "frame-canvas");
