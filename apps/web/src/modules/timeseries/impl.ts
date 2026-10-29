import { legacyImpl } from "@/viewers/legacy";
import { signalAdapter } from "@/viewers/signal/adapter";

export default legacyImpl(signalAdapter, "strip-chart");
