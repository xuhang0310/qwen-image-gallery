export function imageFileError(file) {
  return !file ||
    file.size > 10 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ? "请选择 10MB 以内的 PNG、JPEG 或 WebP"
    : "";
}
