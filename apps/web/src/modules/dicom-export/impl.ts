import type { ModuleImpl } from "@/platform/module";
import { dicomSegExporter, dicomSrExporter } from "@/modules/dicom-export/exporters";

export default { exporters: { "dicom-seg": dicomSegExporter, "dicom-sr": dicomSrExporter } } satisfies ModuleImpl;
