const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inlineVideoAction,
  inlineVideoInputSignature,
  optimizedVideoText,
  originalVideoPrompt,
} = require("../shared/video-inline.mjs");

test("Original input survives repeated optimization, manual editing and generation, while old overwritten nodes do not invent an original", async () => {
  const node = model();
  node.prompt = "  原始描述\n人物说：你好。  ";
  const original = node.prompt;
  const callbacks = {
    optimize: true,
    signature: () => inlineVideoInputSignature(node, [], "beta3-lite"),
    isPresent: () => true,
    isEngineReady: () => true,
    notify: () => {},
    prepare: async () => prepared(node, "优化后的完整描述"),
    submit: async () => {},
  };
  assert.equal(originalVideoPrompt(node), original);
  await inlineVideoAction(node, callbacks);
  assert.equal(node.originalPrompt, original);
  node.prompt = "修改过的优化描述";
  await inlineVideoAction(node, callbacks);
  assert.equal(originalVideoPrompt(node), original);
  await inlineVideoAction(node, { ...callbacks, optimize: false });
  assert.equal(node.originalPrompt, original);
  const legacy = { ...model(), inlineVideo: prepared(model()) };
  assert.equal(originalVideoPrompt(legacy), null);
  await inlineVideoAction(legacy, {
    ...callbacks,
    signature: () => inlineVideoInputSignature(legacy),
    prepare: async () => prepared(legacy),
  });
  assert.equal(originalVideoPrompt(legacy), null);
  const failed = model();
  await inlineVideoAction(failed, {
    ...callbacks,
    signature: () => inlineVideoInputSignature(failed),
    prepare: async () => {
      throw Error("AI failed");
    },
  });
  assert.equal(failed.originalPrompt, undefined);
});
const {
  videoReviewSignature,
  videoReviewReady,
} = require("../shared/video-review.mjs");
const { inferVideoReview } = require("../lib/videos");
const model = () => ({
  id: "generator",
  prompt: "女人微笑挥手，人物说：你好。",
  dialogue: "",
  quality: "480P",
  ratio: "16:9",
  seconds: 6,
  framing: "contain",
  seed: 42,
});
function prepared(node, prompt = node.prompt, token = "CURRENT") {
  const parameters = { ...node, prompt };
  delete parameters.inlineVideo;
  const review = {
    version: 1,
    scene: "女人微笑挥手。",
    vocalMode: "speech",
    vocalText: "你好。",
    music: false,
    backgroundMusic: false,
    workflowPreset: "beta3-lite",
    timeline: [{ start: 0, end: node.seconds, action: "微笑挥手，说第一句。" }],
    enginePrompt: `${token} <d>[CN]你好。</d> Closes the mouth after speaking.`,
  };
  review.compiledSignature = videoReviewSignature(review, parameters);
  return { parameters, review };
}
test("Optimization fills only the existing input, stores an invisible native prompt and generation reuses it verbatim", async () => {
  const node = model();
  let prepares = 0;
  const submissions = [];
  const callbacks = {
    signature: () => inlineVideoInputSignature(node, [], "beta3-lite"),
    isPresent: () => true,
    isEngineReady: () => true,
    notify: () => {},
    prepare: async (optimize) => {
      prepares++;
      assert.equal(optimize, true);
      return prepared(
        node,
        "0–6s: 女人微笑挥手。\n人物台词（原文）：你好。",
        "OPTIMIZED",
      );
    },
    submit: async (p) => submissions.push(p),
  };
  assert.equal(
    await inlineVideoAction(node, { ...callbacks, optimize: true }),
    true,
  );
  assert.equal(submissions.length, 0);
  assert.match(node.prompt, /0–6s/);
  assert.equal(
    videoReviewReady(node.inlineVideo.review, node.inlineVideo.parameters),
    true,
  );
  assert.equal(await inlineVideoAction(node, callbacks), true);
  assert.equal(prepares, 1);
  assert.equal(
    submissions[0].review.enginePrompt,
    node.inlineVideo.review.enginePrompt,
  );
  assert.equal(submissions[0].approved, true);
  assert.equal(submissions[0].prompt, node.prompt);
});
test("Manual edits, reference role/order and duration invalidate native caches and direct generation prepares the current input", async () => {
  const node = model();
  let refs = [
    { id: "one", url: "/api/images/view?filename=one.png" },
    { id: "two", url: "/api/images/view?filename=two.png" },
  ];
  let prepares = 0;
  const submissions = [];
  const callbacks = {
    signature: () => inlineVideoInputSignature(node, refs, "beta3-lite"),
    isPresent: () => true,
    isEngineReady: () => true,
    notify: () => {},
    prepare: async (optimize) => {
      assert.equal(optimize, false);
      return prepared(node, node.prompt, "VERSION-" + ++prepares);
    },
    submit: async (p) => submissions.push(p),
  };
  for (const mutate of [
    () => {},
    () => (node.prompt = "女人慢慢点头。"),
    () => (node.seconds = 8),
    () => (node.referenceRoles = { one: "scene", two: "character" }),
    () => (refs = refs.reverse()),
    () => (refs[0].url += "&version=2"),
  ]) {
    mutate();
    assert.equal(await inlineVideoAction(node, callbacks), true);
    assert.equal(submissions.at(-1).prompt, node.prompt);
    assert.equal(submissions.at(-1).seconds, node.seconds);
  }
  assert.equal(prepares, 6);
  assert.equal(
    submissions.at(-1).review.enginePrompt.startsWith("VERSION-6"),
    true,
  );
});
test("Failure, concurrent actions, deletion, changing inputs and disconnect never replace text or submit stale prompts", async () => {
  for (const reason of ["error", "deleted", "changed", "disconnected"]) {
    const node = model();
    const original = node.prompt;
    let present = true,
      ready = true,
      release,
      submits = 0;
    const gate = new Promise((r) => (release = r));
    const callbacks = {
      signature: () => inlineVideoInputSignature(node, [], "beta3-lite"),
      isPresent: () => present,
      isEngineReady: () => ready,
      notify: () => {},
      prepare: async () => {
        await gate;
        if (reason === "error") throw Error("AI failed");
        if (reason === "deleted") present = false;
        if (reason === "changed") node.prompt = "用户新输入";
        if (reason === "disconnected") ready = false;
        return prepared(node);
      },
      submit: async () => submits++,
    };
    const first = inlineVideoAction(node, callbacks);
    assert.equal(
      await inlineVideoAction(node, { ...callbacks, optimize: true }),
      false,
    );
    release();
    assert.equal(await first, false);
    assert.equal(submits, 0);
    assert.equal(node.prompt, reason === "changed" ? "用户新输入" : original);
    assert.equal(node.inlinePending, false);
  }
});
test("Readable optimization preserves complete Chinese dialogue, singing/voiceover and picture roles through subsequent manual edits", () => {
  const parameters = {
    ...model(),
    references: [{ role: "character" }, { role: "scene" }],
  };
  const original = "你好。今天也很开心！\n明天见，你说呢？";
  for (const mode of ["speech", "singing", "voiceover", "none"]) {
    const review = {
      ...prepared(model()).review,
      vocalMode: mode,
      vocalText: mode === "none" ? "" : original,
      scene: "<Picture 1>人物进入<Picture 2>，自然微笑。",
    };
    const text = optimizedVideoText(review, parameters);
    assert.match(text, /人物参考 1人物进入场景参考 1/);
    assert.doesNotMatch(text, /<Picture|<d>|integrated_multimodal/);
    const parsed = inferVideoReview(text.replace("自然微笑", "自然点头"), "");
    assert.equal(parsed.vocalMode, mode);
    assert.equal(parsed.vocalText, review.vocalText);
  }
});
