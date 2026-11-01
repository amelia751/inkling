/* MetaImage (.mha, inline uncompressed data) -> NIfTI-1 (.nii), as a WASI command
 * (todo10 D3 trial). argv: [name, /in/<input>, /out]. Exit 0 ok, 2 unsupported input.
 * Built inside our boundary with a pinned toolchain:
 *   python -m ziglang cc --target=wasm32-wasi -O2 metaimage.c -o metaimage.wasm
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

static int dims[3] = {1, 1, 1}, ndim = 0, msb = 0, datatype = 0, bitpix = 0;
static float spacing[3] = {1, 1, 1};

static int element(const char *v) {
  struct { const char *name; int code, bits; } t[] = {
    {"MET_UCHAR", 2, 8}, {"MET_CHAR", 256, 8}, {"MET_SHORT", 4, 16}, {"MET_USHORT", 512, 16},
    {"MET_INT", 8, 32}, {"MET_UINT", 768, 32}, {"MET_FLOAT", 16, 32}, {"MET_DOUBLE", 64, 64}};
  for (unsigned i = 0; i < sizeof t / sizeof *t; i++)
    if (!strcmp(v, t[i].name)) { datatype = t[i].code; bitpix = t[i].bits; return 1; }
  return 0;
}

static void swap(uint8_t *p, size_t n, int w) {
  for (size_t i = 0; i + w <= n; i += w)
    for (int a = 0, b = w - 1; a < b; a++, b--) { uint8_t c = p[i + a]; p[i + a] = p[i + b]; p[i + b] = c; }
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  FILE *in = fopen(argv[1], "rb");
  if (!in) return 2;
  char line[512], key[128], val[384];
  int local = 0;
  while (fgets(line, sizeof line, in)) {
    if (sscanf(line, " %127[^= ] = %383[^\r\n]", key, val) != 2) return 2;
    if (!strcmp(key, "NDims")) ndim = atoi(val);
    else if (!strcmp(key, "DimSize")) sscanf(val, "%d %d %d", &dims[0], &dims[1], &dims[2]);
    else if (!strcmp(key, "ElementSpacing")) sscanf(val, "%f %f %f", &spacing[0], &spacing[1], &spacing[2]);
    else if (!strcmp(key, "ElementType")) { if (!element(val)) return 2; }
    else if (!strcmp(key, "CompressedData")) { if (!strcmp(val, "True")) return 2; }
    else if (!strcmp(key, "BinaryDataByteOrderMSB")) msb = !strcmp(val, "True");
    else if (!strcmp(key, "ElementDataFile")) { local = !strcmp(val, "LOCAL"); break; }
  }
  if (!local || ndim < 2 || ndim > 3 || !datatype) return 2;
  size_t n = (size_t)dims[0] * dims[1] * dims[2] * (bitpix / 8);
  uint8_t *data = malloc(n);
  if (!data || fread(data, 1, n, in) != n) return 2;
  fclose(in);
  if (msb && bitpix > 8) swap(data, n, bitpix / 8);

  uint8_t hdr[352] = {0};
  int32_t i32; int16_t i16; float f;
  i32 = 348; memcpy(hdr, &i32, 4);
  int16_t d[8] = {(int16_t)ndim, (int16_t)dims[0], (int16_t)dims[1], (int16_t)dims[2], 1, 1, 1, 1};
  memcpy(hdr + 40, d, 16);
  i16 = (int16_t)datatype; memcpy(hdr + 70, &i16, 2);
  i16 = (int16_t)bitpix; memcpy(hdr + 72, &i16, 2);
  float pix[8] = {1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1};
  memcpy(hdr + 76, pix, 32);
  f = 352; memcpy(hdr + 108, &f, 4);        /* vox_offset */
  f = 1; memcpy(hdr + 112, &f, 4);          /* scl_slope */
  hdr[123] = 2;                             /* xyzt_units: mm */
  i16 = 0; memcpy(hdr + 252, &i16, 2);      /* qform_code */
  i16 = 1; memcpy(hdr + 254, &i16, 2);      /* sform_code: scanner */
  float srow[12] = {spacing[0], 0, 0, 0, 0, spacing[1], 0, 0, 0, 0, spacing[2], 0};
  memcpy(hdr + 280, srow, 48);
  memcpy(hdr + 344, "n+1", 4);

  char path[600];
  snprintf(path, sizeof path, "%s/volume.nii", argv[2]);
  FILE *out = fopen(path, "wb");
  if (!out || fwrite(hdr, 1, 352, out) != 352 || fwrite(data, 1, n, out) != n) return 1;
  fclose(out);
  snprintf(path, sizeof path, "%s/output.json", argv[2]);
  out = fopen(path, "w");
  if (!out) return 1;
  fputs("{\"shape\":\"assets\",\"assets\":[{\"path\":\"volume.nii\",\"mediaType\":\"application/x-nifti\"}]}", out);
  fclose(out);
  return 0;
}
