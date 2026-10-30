import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { dicomSegExporter, dicomSrExporter } from "./exporters";

export default { exporters: { "dicom-seg": dicomSegExporter, "dicom-sr": dicomSrExporter } } satisfies ModuleImpl;
