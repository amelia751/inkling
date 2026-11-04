/**
 * Upload chunk size (todo24 D4): every uploader sends file bytes in PUT bodies of at most this
 * many bytes. Cloud Run refuses an HTTP/1 request body over 32 MiB, and the kernel enforces the
 * same cap in every mode (`API_UPLOAD_MAX_CHUNK_BYTES`), so this stays well below it.
 */
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

/** The kernel's default chunk cap (`upload_max_chunk_bytes` in the api config): Cloud Run's 32 MiB. */
export const KERNEL_MAX_CHUNK_BYTES = 32 * 1024 * 1024;
