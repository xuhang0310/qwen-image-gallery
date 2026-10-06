export function beginImageEdit(node, parameters) {
  if (!node?.url || node.imageEdit) return false;
  node.imageEdit = {
    parameters: JSON.parse(JSON.stringify(parameters)),
    jobId: null,
    status: "preparing",
  };
  delete node.imageEditError;
  return true;
}

export function failImageEdit(node, message) {
  delete node.imageEdit;
  node.imageEditError = message || "编辑失败，原图已保留";
}

export function attachImageEdit(node, job) {
  if (!node.imageEdit) return;
  node.imageEdit.jobId = job.id;
  node.imageEdit.status = job.status;
}

export function syncImageEdit(node, job) {
  if (node.imageEdit?.jobId !== job.id) return false;
  node.imageEdit.status = job.status;
  if (job.status === "completed" && job.imageUrl) {
    const parameters = node.imageEdit.parameters;
    Object.assign(node, {
      status: "done",
      jobId: job.id,
      jobStatus: job.status,
      prompt: parameters.prompt,
      ratio: parameters.ratio,
      quality: parameters.quality,
      provider: job.provider || "local",
      model: job.model,
      url: job.imageUrl,
      thumbnailUrl: job.thumbnailUrl,
      downloadUrl: job.downloadUrl,
      width: job.finalWidth || job.width || job.dimensions?.finalWidth,
      height: job.finalHeight || job.height || job.dimensions?.finalHeight,
    });
    // A previously uploaded source describes the old pixels, not this result.
    delete node.sourceImage;
    delete node.error;
    delete node.imageEdit;
    delete node.imageEditError;
  } else if (["failed", "cancelled", "completed"].includes(job.status)) {
    failImageEdit(
      node,
      job.error ||
        (job.status === "completed"
          ? "编辑任务未返回图片，原图已保留"
          : undefined) ||
        (job.status === "cancelled"
          ? "编辑已取消，原图已保留"
          : "编辑失败，原图已保留"),
    );
  }
  return true;
}
