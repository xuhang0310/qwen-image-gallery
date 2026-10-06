const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateTimeline,
  timelineText,
} = require("../shared/video-timeline.mjs");
const { confirmVideoReview } = require("../shared/video-confirm.mjs");
const { videoReviewSignature } = require("../shared/video-review.mjs");
const parameters = {
  prompt: "人物面对镜头挥手。",
  dialogue: "",
  quality: "480P",
  ratio: "16:9",
  seconds: 6,
  framing: "contain",
  seed: 42,
};
const review = {
  version: 1,
  scene: "人物面对镜头挥手。",
  vocalMode: "speech",
  vocalText: "你好。",
  music: false,
  backgroundMusic: false,
  workflowPreset: "beta3-lite",
  timeline: [
    { start: 0, end: 0.2, action: "镜头推进" },
    { start: 0.2, end: 6, action: "微笑挥手，说第一句。" },
  ],
  enginePrompt:
    "0–0.2s: Camera moves in.\n0.2–6s: Waves. <d>[CN]你好。</d> Closes the mouth after speaking.",
};
review.compiledSignature = videoReviewSignature(review, parameters);
test("Timeline ranges are continuous, bounded, non-overlapping, and preserve explicit sub-second camera cues", () => {
  assert.equal(validateTimeline(review.timeline, 6), review.timeline);
  assert.match(timelineText(review.timeline), /^0–0.2s: 镜头推进\n0.2–6s:/);
  for (const bad of [
    [{ start: 0, end: 0, action: "推进" }],
    [{ start: 1, end: 6, action: "挥手" }],
    [{ start: 0, end: 7, action: "挥手" }],
    [
      { start: 0, end: 3, action: "挥手" },
      { start: 2, end: 6, action: "点头" },
    ],
    [
      { start: 0, end: 3, action: "挥手" },
      { start: 4, end: 6, action: "点头" },
    ],
  ])
    assert.throws(() => validateTimeline(bad, 6));
});
test("Edited card confirmation prepares once, submits the new preview, and rejects concurrent clicks", async () => {
  const node = { review: structuredClone(review), videoParameters: parameters };
  node.review.timeline[1].action = "慢慢点头";
  let release;
  const gate = new Promise((r) => (release = r));
  const events = [];
  const callbacks = {
    isPresent: () => true,
    isEngineReady: () => true,
    notify: () => {},
    prepare: async () => {
      events.push("prepare");
      await gate;
      node.review.enginePrompt = "UPDATED CURRENT TIMELINE";
      node.review.compiledSignature = videoReviewSignature(
        node.review,
        node.videoParameters,
      );
    },
    submit: async (p) => {
      events.push("submit");
      assert.equal(p.review.enginePrompt, "UPDATED CURRENT TIMELINE");
      assert.equal(p.approved, true);
    },
  };
  const first = confirmVideoReview(node, callbacks);
  assert.equal(node.confirmPending, true);
  assert.equal(await confirmVideoReview(node, callbacks), false);
  release();
  assert.equal(await first, true);
  assert.deepEqual(events, ["prepare", "submit"]);
  assert.equal(node.confirmPending, false);
});
test("Failed refresh, deletion during refresh and lost engine connection never submit a video", async () => {
  for (const condition of ["failure", "deleted", "disconnected"]) {
    const node = {
      review: structuredClone(review),
      videoParameters: parameters,
      reviewError: "需更新",
    };
    let present = true,
      ready = true,
      submitted = false;
    const result = await confirmVideoReview(node, {
      isPresent: () => present,
      isEngineReady: () => ready,
      notify: () => {},
      prepare: async () => {
        node.reviewError = "";
        if (condition === "failure") throw Error("时间段格式无效");
        if (condition === "deleted") present = false;
        if (condition === "disconnected") ready = false;
      },
      submit: async () => {
        submitted = true;
      },
    });
    assert.equal(result, false);
    assert.equal(submitted, false);
    assert.equal(node.confirmPending, false);
  }
});
