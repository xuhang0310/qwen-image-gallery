const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createVideoPromptAI, RULES } = require("../lib/video-prompt-ai");
const { inferVideoReview, createVideoWorkflow } = require("../lib/videos");
const {
  videoReviewSignature,
  videoReviewReady,
  validateVideoPromptNode,
} = require("../shared/video-review.mjs");
const {
  performanceWarnings,
  validatePerformance,
} = require("../shared/video-performance.mjs");
const parameters = {
  prompt: "美女撒娇，你好凶啊，你好凶啊，好吓人",
  dialogue: "",
  seconds: 10,
  ratio: "9:16",
  quality: "480P",
  framing: "contain",
  seed: 42,
};
const review = inferVideoReview(parameters.prompt, "");
const plan = {
  overview: "平静、轻微委屈、轻轻示弱，依次发生。",
  startingState: "干眼，眉毛自然，嘴角放松。",
  camera: "正前方平视，脸部特写，85mm，十秒静止机位。",
  beats: [
    {
      line: "你好凶啊，",
      face: "眉心轻轻抬起。",
      volume: "低音量",
      pace: "慢速",
      pitch: "稍低",
      pauseBefore: 0,
    },
    {
      line: "你好凶啊，",
      face: "嘴角下落，眉心向上皱。",
      volume: "更轻",
      pace: "更慢",
      pitch: "稍高，轻微颤音",
      pauseBefore: 0.4,
    },
    {
      line: "好吓人",
      face: "下巴轻颤，双眼睁大。",
      volume: "轻声",
      pace: "慢速",
      pitch: "声音轻哑",
      pauseBefore: 0.3,
    },
  ],
};
const english = {
  overview:
    "The expression progresses from neutral to a slight pout to a soft, pleading expression.",
  startingState: "Dry eyes, relaxed brows and neutral mouth corners.",
  camera:
    "Eye-level frontal close-up, 85mm. The camera holds a static shot for ten seconds.",
  beats: plan.beats.map((b, i) => ({
    ...b,
    face: [
      "Brows lift slightly.",
      "Mouth corners lower and inner brows rise.",
      "The chin trembles slightly and eyes widen.",
    ][i],
    volume: "Soft volume",
    pace: "Slow",
    pitch: "A slightly rising pitch",
  })),
};
const response = () => ({
  scene: "人物面对镜头轻轻撒娇。",
  sceneEnglish: "The woman faces the camera with a gently pleading expression.",
  performance: structuredClone(plan),
  performanceEnglish: structuredClone(english),
  warnings: [],
});
async function harness(t, reply = response()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-ai-test-"));
  const app = express();
  app.use(express.json());
  const calls = [];
  const ai = createVideoPromptAI({
    app,
    dataDir: dir,
    captureImageEngine: () => ({
      baseUrl: "https://example.test/v1",
      apiKey: "sk-private-test",
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            { id: "gpt-6.1-sol" },
            { id: "gpt-image-2" },
            { id: "whisper-1" },
          ],
        });
      return Response.json({
        choices: [
          {
            message: {
              content:
                typeof reply === "string" ? reply : JSON.stringify(reply),
            },
          },
        ],
      });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  );
  const request = async (endpoint, body) => {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}${endpoint}`,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    return { status: r.status, data: await r.json() };
  };
  await request("/api/video-prompt-ai/config", {
    provider: "reuse",
    model: "gpt-6.1-sol",
  });
  return { ai, calls, request };
}
test("AI uses the configured text model and all eight acting rules; original dialogue stays Chinese in one block", async (t) => {
  const h = await harness(t);
  const result = await h.ai.write(review, parameters);
  assert.equal(result.aiModel, "gpt-6.1-sol");
  assert.equal(result.vocalText, review.vocalText);
  assert.equal(result.performance.beats.length, 3);
  assert.equal(h.calls[0].body.model, "gpt-6.1-sol");
  assert.equal(h.calls[0].body.messages[0].content, RULES);
  assert.match(RULES, /3.5/);
  assert.match(RULES, /4.6/);
  assert.match(RULES, /双唇闭着/);
  const wf = createVideoWorkflow(
    {
      ...parameters,
      sceneEnglish: result.sceneEnglish,
      performanceEnglish: result.performanceEnglish,
      audioSpec: {
        spoken: true,
        speechLines: [result.vocalText],
        lyrics: [],
        music: false,
      },
    },
    true,
  );
  const actual = wf.workflow["5"].inputs.prompt;
  assert.equal((actual.match(/<d>/g) || []).length, 1);
  assert.ok(actual.endsWith("</d> Closes the mouth after speaking."));
  assert.match(actual, /<d>\[CN\]你好凶啊，你好凶啊，好吓人<\/d>/);
  assert.match(actual, /lips stay closed for 0.4 seconds/);
  assert.equal(
    /[\u3400-\u9fff]/.test(actual.replace(/<d>[\s\S]*?<\/d>/g, "")),
    false,
  );
  const compiled = {
    ...result,
    version: 1,
    workflowPreset: "beta3-lite",
    enginePrompt: actual,
  };
  compiled.compiledSignature = videoReviewSignature(compiled, parameters);
  assert.equal(videoReviewReady(compiled, parameters), true);
  compiled.performance.beats[0].volume = "高音量";
  assert.equal(videoReviewReady(compiled, parameters), false);
  validateVideoPromptNode({ videoParameters: parameters, review: compiled });
});
test("Configuration never returns credentials and lists text models independently of image models", async (t) => {
  const h = await harness(t);
  const config = await h.request("/api/video-prompt-ai/config");
  assert.equal(config.data.ready, true);
  assert.equal(config.data.model, "gpt-6.1-sol");
  assert.ok(!JSON.stringify(config.data).includes("sk-private"));
  assert.deepEqual(
    (await h.request("/api/video-prompt-ai/models")).data.models,
    ["gpt-6.1-sol"],
  );
  assert.equal(
    (
      await h.request("/api/video-prompt-ai/config", {
        provider: "custom",
        model: "local-model",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "",
      })
    ).status,
    200,
  );
  assert.equal(
    (await h.request("/api/video-prompt-ai/config")).data.ready,
    true,
  );
  assert.equal(
    (
      await h.request("/api/video-prompt-ai/config", {
        provider: "custom",
        model: "text",
        baseUrl: "https://user:secret@example.test",
      })
    ).status,
    400,
  );
});
test("Malformed AI replies and translated/replaced dialogue fail rather than inventing a video prompt", async (t) => {
  const malformed = await harness(t, "not json");
  await assert.rejects(malformed.ai.write(review, parameters), /格式无效/);
  const replaced = response();
  replaced.performanceEnglish.beats[0].line = "You are so mean,";
  const h = await harness(t, replaced);
  await assert.rejects(h.ai.write(review, parameters), /原文/);
  assert.throws(
    () =>
      validatePerformance(
        { ...plan, beats: [{ ...plan.beats[0], pauseBefore: NaN }] },
        review.vocalText,
        "speech",
      ),
    /停顿/,
  );
});
test("Word budgets use pause-adjusted duration, and visual-only expansion cannot acquire dialogue", async (t) => {
  assert.match(
    performanceWarnings(
      {
        ...review,
        vocalText: "很".repeat(35),
        performance: { beats: [{ pauseBefore: 1 }] },
      },
      10,
      "slow",
    )[0],
    /31 字/,
  );
  assert.equal(
    performanceWarnings({ ...review, vocalText: "很".repeat(40) }, 10, "fast")
      .length,
    0,
  );
  const visual = {
    ...review,
    vocalMode: "none",
    vocalText: "",
    scene: "人物走过街道转身微笑。",
  };
  const data = response();
  data.performance.beats = [];
  data.performanceEnglish.beats = [];
  const h = await harness(t, data);
  const expanded = await h.ai.write(visual, parameters);
  assert.equal(expanded.vocalMode, "none");
  assert.equal(expanded.vocalText, "");
  assert.deepEqual(expanded.performance.beats, []);
});
test("Manual edits are authoritative during translation; the AI cannot replace the reviewed Chinese plan", async (t) => {
  const data = response();
  data.performance.startingState = "AI自行改成流泪";
  data.scene = "被模型改写";
  const h = await harness(t, data);
  const source = { ...review, performance: structuredClone(plan) };
  const translated = await h.ai.write(source, parameters, {
    translateOnly: true,
  });
  assert.deepEqual(translated.performance, plan);
  assert.equal(translated.scene, source.scene);
});

test("AI receives stable per-picture roles and scene numbering without image credentials", async (t) => {
  const h = await harness(t);
  const references = ["character", "scene", "scene"].map((role, i) => ({
    role,
    sourceImage: {
      name: "test-" + i + ".png",
      subfolder: "qwen-workbench",
      type: "input",
    },
  }));
  await h.ai.write(review, { ...parameters, references });
  const input = JSON.parse(h.calls[0].body.messages[1].content);
  assert.deepEqual(
    input.references.map((r) => r.role),
    ["character", "scene", "scene"],
  );
  assert.deepEqual(
    input.references.map((r) => r.picture),
    [1, 2, 3],
  );
  assert.deepEqual(
    input.references.map((r) => r.label),
    ["人物参考 1", "场景参考 1", "场景参考 2"],
  );
  assert.match(input.referenceAssignments, /<Picture 3> is scene reference 2/);
  assert.ok(!JSON.stringify(input).includes("sk-private"));
});
