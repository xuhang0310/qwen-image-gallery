const imageUrl = (value) =>
  typeof value === "string" &&
  /^\/api\/images\/(view|download)\?/.test(value) &&
  !/[\r\n]/.test(value);
const videoUrl = (value) =>
  typeof value === "string" &&
  /^\/api\/videos\/media\/[a-zA-Z0-9-]+(?:\?[^\r\n]*)?$/.test(value);

// History visibility belongs to a project. Generated files remain shared assets.
export function mediaLibrary(images = [], videos = []) {
  const assets = new Map();
  for (const job of images) {
    if (job.status !== "completed") continue;
    const outputs = job.imageUrls?.length
      ? job.imageUrls
      : [
          {
            url: job.imageUrl,
            thumbnailUrl: job.thumbnailUrl,
            downloadUrl: job.downloadUrl,
          },
        ];
    for (const [assetIndex, output] of outputs.entries()) {
      if (!imageUrl(output?.url)) continue;
      const assetId = `image:${job.id}:${assetIndex}`;
      assets.set(assetId, {
        ...job,
        ...job.dimensions,
        assetId,
        assetIndex,
        mediaType: "image",
        imageUrl: output.url,
        thumbnailUrl: imageUrl(output.thumbnailUrl)
          ? output.thumbnailUrl
          : output.url + "&thumbnail=1",
        downloadUrl: imageUrl(output.downloadUrl)
          ? output.downloadUrl
          : output.url.replace("/view?", "/download?"),
      });
    }
  }
  for (const job of videos) {
    if (job.status !== "completed" || !videoUrl(job.videoUrl)) continue;
    const assetId = `video:${job.id}`;
    assets.set(assetId, {
      ...job,
      ...job.dimensions,
      assetId,
      mediaType: "video",
      downloadUrl: videoUrl(job.downloadUrl)
        ? job.downloadUrl
        : job.videoUrl +
          (job.videoUrl.includes("?") ? "&" : "?") +
          "download=1",
    });
  }
  return [...assets.values()].sort(
    (a, b) => b.createdAt - a.createdAt || a.assetId.localeCompare(b.assetId),
  );
}

export function assetOnBoard(asset, nodes) {
  return nodes.find(
    (node) =>
      node.jobId === asset.id &&
      (asset.mediaType === "video"
        ? node.kind === "video"
        : node.kind !== "video" &&
          (node.assetIndex || 0) === (asset.assetIndex || 0)),
  );
}
