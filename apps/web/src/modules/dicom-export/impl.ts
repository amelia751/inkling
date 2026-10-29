import type { ModuleImpl } from "@/platform/module";
import { dicomSegExporter, dicomSrExporter } from "@/viewers/cornerstone/dicomExporters";

export default { exporters: { "dicom-seg": dicomSegExporter, "dicom-sr": dicomSrExporter } } satisfies ModuleImpl;
