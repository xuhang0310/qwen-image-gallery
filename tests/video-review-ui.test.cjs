const test = require("node:test");
const assert = require("node:assert/strict");
const { createSSRApp } = require("vue");
const { renderToString } = require("@vue/server-renderer");
const { videoReviewSignature } = require("../shared/video-review.mjs");
const { translateScene } = require("../lib/video-scene");

test("A coy-expression scene stays a visual cue rather than translated song lyrics", async () => {
  const english = await translateScene("美女撒娇");
  assert.match(english, /woman.*coy.*pleading/);
  assert.doesNotMatch(english, /♪|♫|sweet|sing|<d>/);
});

test("Prompt card allows edited drafts to confirm via automatic preparation and prevents duplicate pending confirmation", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { default: Card } = await server.ssrLoadModule(
      "/src/components/VideoPrompt.vue",
    );
    const { normalizeBoard } = await server.ssrLoadModule("/src/domain.js");
    const parameters = {
      prompt: "美女撒娇，你好凶啊",
      dialogue: "",
      quality: "480P",
      ratio: "9:16",
      seconds: 4,
      framing: "contain",
      seed: 42,
    };
    const review = {
      version: 1,
      scene: "美女撒娇",
      vocalMode: "speech",
      vocalText: "你好凶啊",
      music: false,
      backgroundMusic: false,
      warnings: [],
      enginePrompt: "A woman acts coyly. <d>[CN]你好凶啊</d>",
      sceneEnglish: "A woman acts coyly.",
      workflowPreset: "beta3-lite",
    };
    review.compiledSignature = videoReviewSignature(review, parameters);
    const node = {
      id: "card",
      kind: "video-prompt",
      status: "text",
      x: 0,
      y: 0,
      prompt: parameters.prompt,
      videoParameters: parameters,
      review,
      reviewPending: false,
    };
    const render = (n, ready = true) =>
      renderToString(
        createSSRApp(Card, { node: n, engine: { ready }, disabled: false }),
      );
    const confirmation = (html) =>
      html.match(/<button[^>]*type="submit"[^>]*>/)[0];
    const html = await render(node);
    assert.doesNotMatch(confirmation(html), /disabled/);
    assert.match(html, /中文普通话/);
    assert.match(html, /你好凶啊/);
    assert.match(html, /实际提交的模型提示词/);
    assert.match(html, /readonly/);
    assert.doesNotMatch(
      confirmation(
        await render({
          ...node,
          review: { ...review, vocalText: "改过的台词" },
        }),
      ),
      /disabled/,
    );
    assert.match(
      confirmation(await render({ ...node, reviewPending: true })),
      /disabled/,
    );
    assert.match(
      confirmation(await render({ ...node, review: null })),
      /disabled/,
    );
    assert.match(confirmation(await render(node, false)), /disabled/);
    assert.doesNotMatch(
      confirmation(await render({ ...node, reviewError: "翻译失败" })),
      /disabled/,
    );
    const restored = normalizeBoard({
      nodes: [{ ...node, reviewPending: true }],
      edges: [],
    }).nodes[0];
    assert.equal(restored.kind, "video-prompt");
    assert.equal(restored.reviewPending, false);
    assert.match(restored.reviewError, /中断/);
    assert.equal(restored.review.enginePrompt, review.enginePrompt);
    const incomplete = normalizeBoard({
      nodes: [{ ...node, review: { ...review, vocalText: "" } }],
      edges: [],
    }).nodes[0];
    assert.ok(incomplete, "Incomplete edits must survive autosave/restoration");
    assert.doesNotMatch(confirmation(await render(incomplete)), /disabled/);
    assert.match(
      confirmation(await render({ ...node, confirmPending: true })),
      /disabled/,
    );
    assert.match(
      await render({
        ...node,
        review: {
          ...review,
          timeline: [
            { start: 0, end: 1, action: "镜头推进" },
            { start: 1, end: 4, action: "自然挥手" },
          ],
        },
      }),
      /第1段开始秒数/,
    );
  } finally {
    await server.close();
  }
});

test("Multiple reference controls and frozen prompt cards survive project restore", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { default: Composer } = await server.ssrLoadModule(
      "/src/components/VideoComposer.vue",
    );
    const { default: Card } = await server.ssrLoadModule(
      "/src/components/VideoPrompt.vue",
    );
    const { normalizeBoard } = await server.ssrLoadModule("/src/domain.js");
    const refs = ["character", "scene", "scene"].map((role, i) => ({
      role,
      sourceImage: {
        name: "test-" + i + ".png",
        subfolder: "qwen-workbench",
        type: "input",
      },
    }));
    const model = {
      id: "generator",
      prompt: "人物在场景中挥手",
      quality: "480P",
      ratio: "16:9",
      seconds: 6,
      framing: "contain",
    };
    const html = await renderToString(
      createSSRApp(Composer, {
        model,
        references: refs.map((r, i) => ({
          id: "ref" + i,
          url: "/api/images/view?filename=test-" + i + ".png",
        })),
        referenceCount: 3,
        disabled: false,
        engine: { ready: true, maxReferences: 9 },
      }),
    );
    assert.match(html, /添加参考图/);
    assert.match(html, /参考图3用途/);
    assert.doesNotMatch(html, /<button[^>]*type="submit"[^>]*disabled/);
    const node = {
      id: "card",
      kind: "video-prompt",
      status: "text",
      x: 0,
      y: 0,
      prompt: model.prompt,
      videoParameters: { ...model, dialogue: "", references: refs },
    };
    const restored = normalizeBoard({
      nodes: [node],
      edges: [],
      zoom: 1,
      pan: { x: 0, y: 0 },
    }).nodes[0];
    assert.deepEqual(restored.videoParameters.references, refs);
    const card = await renderToString(
      createSSRApp(Card, {
        node: restored,
        engine: { ready: true },
        disabled: false,
      }),
    );
    assert.match(card, /人物参考 1/);
    assert.match(card, /场景参考 2/);
  } finally {
    await server.close();
  }
});

test("Video composer exposes optimization and direct generation, hides native prompts, and restores interrupted drafts", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { default: Composer } = await server.ssrLoadModule(
      "/src/components/VideoComposer.vue",
    );
    const { normalizeBoard } = await server.ssrLoadModule("/src/domain.js");
    const model = {
      id: "generator",
      kind: "video-generator",
      status: "text",
      x: 0,
      y: 0,
      prompt: "人物微笑，人物说：你好。",
      dialogue: "",
      quality: "480P",
      ratio: "16:9",
      seconds: 6,
      framing: "contain",
      seed: 42,
    };
    const engine = {
      ready: true,
      workflowPreset: "beta3-lite",
      maxReferences: 9,
    };
    const { inlineVideoInputSignature } =
      await import("../shared/video-inline.mjs");
    const review = {
      version: 1,
      scene: "人物微笑",
      vocalMode: "speech",
      vocalText: "你好。",
      music: false,
      backgroundMusic: false,
      workflowPreset: "beta3-lite",
      enginePrompt: "HIDDEN_NATIVE_PROMPT <d>[CN]你好。</d>",
    };
    review.compiledSignature = videoReviewSignature(review, model);
    model.inlineVideo = {
      parameters: { ...model },
      review,
      signature: inlineVideoInputSignature(model, [], engine.workflowPreset),
    };
    const render = (n, e = engine) =>
      renderToString(
        createSSRApp(Composer, {
          model: n,
          engine: e,
          referenceCount: 0,
          references: [],
          disabled: false,
        }),
      );
    const html = await render(model);
    assert.match(html, /AI 优化提示词/);
    assert.match(html, /查看原始提示词/);
    assert.match(html, /放大当前提示词/);
    assert.match(html, /生成视频/);
    assert.doesNotMatch(
      html,
      /生成视频提示词|HIDDEN_NATIVE_PROMPT|点击后先生成提示词卡片/,
    );
    const pending = { ...model, inlinePending: "optimize" };
    const busy = await render(pending);
    assert.match(busy, /AI 优化中/);
    assert.match(busy, /<textarea[^>]*disabled/);
    assert.match(busy, /<button[^>]*type="submit"[^>]*disabled/);
    const offline = await render(model, { ...engine, ready: false });
    assert.match(offline, /<button[^>]*type="submit"[^>]*disabled/);
    const restored = normalizeBoard({
      nodes: [pending],
      edges: [],
      pan: { x: 0, y: 0 },
      zoom: 1,
    }).nodes[0];
    assert.equal(restored.inlinePending, false);
    assert.equal(restored.inlineVideo.review.enginePrompt, review.enginePrompt);
    assert.match(restored.inlineError, /中断/);
  } finally {
    await server.close();
  }
});

test("Large prompt viewer displays exact originals and current drafts as read-only, preserves originals on restore and reports missing legacy text", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { default: Viewer } = await server.ssrLoadModule(
      "/src/components/VideoPromptViewer.vue",
    );
    const { normalizeBoard } = await server.ssrLoadModule("/src/domain.js");
    const original = "原始内容\n人物说：你好。";
    const current = "0–2s: 微笑。\n2–6s: 开口说话。";
    const render = async (props) => {
      const context = {};
      await renderToString(
        createSSRApp(Viewer, { open: true, original, current, ...props }),
        context,
      );
      return context.teleports.body;
    };
    const originalHtml = await render({ initialView: "original" });
    assert.ok(originalHtml.includes(original));
    assert.match(originalHtml, /<textarea[^>]*readonly/);
    assert.match(originalHtml, /提示词审核/);
    const currentHtml = await render({ initialView: "current" });
    assert.ok(currentHtml.includes(current));
    assert.doesNotMatch(currentHtml, /type="submit"/);
    const legacy = await render({ original: null });
    assert.match(legacy, /未保存原始提示词/);
    assert.doesNotMatch(legacy, /<textarea/);
    const restored = normalizeBoard({
      nodes: [
        {
          id: "original",
          x: 0,
          y: 0,
          status: "text",
          kind: "video-generator",
          prompt: current,
          originalPrompt: original,
        },
      ],
    }).nodes[0];
    assert.equal(restored.originalPrompt, original);
    assert.equal(restored.prompt, current);
  } finally {
    await server.close();
  }
});
