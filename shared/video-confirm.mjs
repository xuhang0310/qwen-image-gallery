import { videoReviewReady } from "./video-review.mjs";

export async function confirmVideoReview(
  node,
  { isPresent, isEngineReady, prepare, submit, notify },
) {
  if (node.confirmPending || node.reviewPending || !isPresent()) return false;
  if (!isEngineReady()) {
    notify("请先连接视频引擎");
    return false;
  }
  node.confirmPending = true;
  try {
    if (
      !node.review?.timeline ||
      node.reviewError ||
      !videoReviewReady(node.review, node.videoParameters)
    )
      await prepare();
    if (
      !isPresent() ||
      node.reviewError ||
      !node.review?.timeline ||
      !videoReviewReady(node.review, node.videoParameters)
    )
      return false;
    if (!isEngineReady()) {
      notify("视频引擎连接已断开，请重新连接");
      return false;
    }
    const snapshot = JSON.parse(
      JSON.stringify({
        ...node.videoParameters,
        review: node.review,
        approved: true,
      }),
    );
    await submit(snapshot);
    return true;
  } catch (error) {
    node.reviewError = error.message;
    notify(error.message);
    return false;
  } finally {
    node.confirmPending = false;
  }
}
