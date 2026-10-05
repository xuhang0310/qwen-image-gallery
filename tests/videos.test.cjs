const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const sharp = require("sharp");
const {
  createVideos,
  createVideoWorkflow,
  validateVideo,
  historyVideo,
  videoPromptAudio,
} = require("../lib/videos");
const {
  videoQualities,
  videoFrames,
  safeVideoUrl,
} = require("../shared/video.mjs");
const template = require("../workflows/minimax-h3.json");
const parameters = {
  prompt: "A friendly presenter.",
  dialogue: "大家好，我是小雅。",
  quality: "480P",
  seconds: 6,
  framing: "contain",
  seed: 42,
};

async function harness(t, { translateScene } = {}) {
  const jobs = new Map(),
    histories = new Map(),
    calls = [];
  let submitted, uploaded, statusHook;
  const storage = {
    get: (id) => jobs.get(id),
    put: (id, value) => jobs.set(id, structuredClone(value)),
    list: () => [...jobs.values()],
  };
  const app = express();
  app.use(express.json());
  const comfyJson = async (endpoint, options) => {
    calls.push({
      endpoint,
      body:
        typeof options?.body === "string"
          ? JSON.parse(options.body)
          : options?.body,
    });
    if (endpoint.startsWith("/object_info/")) {
      const name = endpoint.split("/").at(-1);
      const required = {};
      for (const node of Object.values(template).filter(
        (node) => node.class_type === name,
      ))
        for (const [key, value] of Object.entries(node.inputs))
          if (typeof value === "string")
            required[key] = [[...(required[key]?.[0] || []), value]];
      return { [name]: { input: { required } } };
    }
    if (endpoint === "/prompt") {
      submitted = JSON.parse(options.body).prompt;
      return { prompt_id: crypto.randomUUID() };
    }
    if (endpoint === "/upload/image") {
      uploaded = Buffer.from(await options.body.get("image").arrayBuffer());
      return {
        name: "reference.png",
        subfolder: "qwen-workbench",
        type: "input",
      };
    }
    if (endpoint.startsWith("/history/")) {
      if (statusHook) await statusHook();
      const id = endpoint.split("/").at(-1);
      return histories.has(id) ? { [id]: histories.get(id) } : {};
    }
    if (endpoint === "/queue")
      return {
        queue_running: [[0, "unrelated-task"]],
        queue_pending: [...jobs.keys()].map((id) => [1, id]),
      };
    if (endpoint === "/interrupt") return {};
    throw new Error("Unexpected endpoint " + endpoint);
  };
  const sourceBuffer = await sharp({
    create: { width: 753, height: 560, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  createVideos({
    app,
    storage,
    comfyJson,
    withComfy: async (endpoint, options, consume) => {
      calls.push({ endpoint, options });
      return consume(
        new Response(Buffer.from("test"), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/100",
            "content-length": "4",
            "accept-ranges": "bytes",
          },
        }),
        options.signal,
      );
    },
    apiImages: {
      validSource: (source) => source?.name === "managed.png",
      sourceBuffer: async () => sourceBuffer,
    },
    validSourceImage: (source) =>
      source?.type === "input" && source?.subfolder === "qwen-workbench",
    isBusy: () => false,
    ...(translateScene ? { translateScene } : {}),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const request = async (endpoint, body, options = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${endpoint}`,
      {
        ...(body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
        ...options,
      },
    );
    const data = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { response, data };
  };
  return {
    jobs,
    histories,
    calls,
    request,
    get submitted() {
      return submitted;
    },
    get uploaded() {
      return uploaded;
    },
    set statusHook(value) {
      statusHook = value;
    },
  };
}

test("All three ratios render at both qualities and preserve speech/audio connections", () => {
  const expected = {
    "480P": {
      "16:9": [854, 480, 864, 480],
      "9:16": [480, 854, 480, 864],
      "1:1": [480, 480, 480, 480],
    },
    "720P": {
      "16:9": [1280, 720, 1280, 736],
      "9:16": [720, 1280, 736, 1280],
      "1:1": [720, 720, 736, 736],
    },
  };
  for (const quality of ["480P", "720P"])
    for (const ratio of ["9:16", "16:9", "1:1"])
      for (const seconds of [4, 6, 8, 10]) {
        const { workflow, dimensions, duration, frames } = createVideoWorkflow(
          { ...parameters, quality, ratio, seconds },
          "qwen-workbench/reference.png",
        );
        const [width, height, renderWidth, renderHeight] =
          expected[quality][ratio];
        assert.equal(workflow["5"].inputs.width % 32, 0);
        assert.equal(workflow["5"].inputs.height % 32, 0);
        assert.equal(workflow["5"].inputs.width, renderWidth);
        assert.equal(workflow["5"].inputs.height, renderHeight);
        assert.equal(workflow["21"].inputs.width, width);
        assert.equal(workflow["21"].inputs.height, height);
        assert.deepEqual(workflow["14"].inputs.images, ["21", 0]);
        assert.deepEqual(workflow["14"].inputs.audio, ["13", 0]);
        assert.ok(
          workflow["5"].inputs.prompt.includes("<d>[CN]大家好，我是小雅。</d>"),
        );
        assert.equal(workflow["9"].inputs.steps, 12);
        assert.equal((frames - 5) % 17, 0);
        assert.equal(duration, frames / 24);
        assert.ok(duration >= seconds && duration < seconds + 17 / 24);
        assert.equal(dimensions.finalWidth, width);
        assert.equal(dimensions.finalHeight, height);
        for (const node of Object.values(workflow))
          for (const input of Object.values(node.inputs))
            if (Array.isArray(input))
              assert.ok(workflow[input[0]], "Every node link resolves");
      }
  const graph = createVideoWorkflow(parameters).workflow;
  assert.equal(graph["5"].inputs.first_frame, undefined);
  assert.equal(graph["16"], undefined);
  assert.equal(
    validateVideo(parameters).ratio,
    "16:9",
    "Legacy jobs default to landscape",
  );
});

test("Rejects invalid quality, duration, empty input and malformed source before submitting", async (t) => {
  const h = await harness(t);
  for (const overrides of [
    { quality: "1080P" },
    { quality: "__proto__" },
    { ratio: "4:3" },
    { ratio: "__proto__" },
    { ratio: null },
    { seconds: 600 },
    { prompt: "", dialogue: "" },
    { dialogue: "a".repeat(201) },
    { seed: -1 },
    { framing: "invalid" },
    { sourceImage: { name: "../secret" } },
  ]) {
    const { response } = await h.request("/api/videos/generate", {
      ...parameters,
      ...overrides,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(h.calls.filter((call) => call.endpoint === "/prompt").length, 0);
  assert.throws(() => validateVideo(null));
  assert.equal(videoFrames(6), 158);
  assert.equal(safeVideoUrl("/api/videos/media/../private"), false);
  assert.equal(safeVideoUrl("https://external/video.mp4"), false);
});

test("Scene descriptions stay visual; only explicit spoken lines or lyrics receive dialogue tags", () => {
  const promptFor = (prompt, dialogue = "") =>
    createVideoWorkflow({
      ...parameters,
      prompt,
      dialogue,
      sceneEnglish: "A woman dances joyfully to DJ music.",
    }).workflow["5"].inputs.prompt;
  const scene = "人物跟随DJ音乐跳欢快的舞蹈，非常欢快，边跳边唱：我的家在东北";
  const sung = promptFor(scene);
  assert.ok(sung.includes("A woman dances joyfully to DJ music."));
  assert.ok(!sung.includes("人物跟随DJ音乐"));
  assert.ok(sung.includes("sings melodically"));
  assert.ok(sung.includes("<d>[CN]我的家在东北</d>"));
  assert.ok(!sung.includes("says with"));
  assert.ok(!sung.includes("presenter"));
  assert.ok(!sung.includes("restrained movement"));
  assert.ok(!sung.includes("stable camera"));
  assert.ok(
    sung.includes(
      "Music plays with the source, genre, rhythm and mood specified",
    ),
  );
  assert.ok(
    sung.includes("non_diegetic_music: N/A"),
    "DJ music is directed inside the scene",
  );

  for (const brief of [
    "人物走过街道，镜头跟随，转身微笑",
    "大家好，我是小雅，今天刚刚出生",
    "人物跟随DJ音乐跳舞",
    "人物自然眨眼，不要口播，不要说话",
    "人物跳舞，不要唱歌，不需要旁白",
    "A woman walks past a window without speech.",
  ]) {
    const output = promptFor(brief);
    assert.ok(!output.includes("<d>"), brief);
    assert.ok(!output.includes("says with"), brief);
    assert.ok(!output.includes("The character speaks"), brief);
    assert.ok(!output.includes("sings melodically"), brief);
  }
  const spoken = promptFor("人物看向镜头，口播：大家好，我是小雅。");
  assert.ok(spoken.includes("<d>[CN]大家好，我是小雅。</d>"));
  assert.ok(!spoken.includes("<d>[CN]人物看向镜头"));
  const quoted = promptFor("人物挥手，说：“大家好，我是小雅。”");
  assert.ok(quoted.includes("<d>[CN]大家好，我是小雅。</d>"));
  const voiceover = promptFor("海浪拍打礁石。旁白：这里是海边。");
  assert.ok(voiceover.includes("says in an off-screen voiceover"));
  assert.ok(voiceover.includes("lips remain closed"));
  const score = promptFor("人物跳舞，背景音乐是轻快的电子配乐");
  assert.ok(score.includes("non_diegetic_music: Musical accompaniment"));
  assert.ok(!score.includes("<d>"));
  const negated = promptFor("人物看向镜头，不要口播：大家好。");
  assert.ok(!negated.includes("<d>"));
  const legacy = promptFor("人物微笑", "你好");
  assert.ok(
    legacy.includes("<d>[CN]你好</d>"),
    "Existing explicit dialogue remains replayable",
  );
});

test("Questions, replies and shouts preserve Chinese dialogue outside scene translation", async (t) => {
  const brief =
    "人物站在现代的客厅，手持长剑处于戒备状态，突然一个男人走了进来，女人将剑搭在男人的肩膀上，厉声问道：哪里的魔族？";
  const parsed = videoPromptAudio(brief);
  assert.deepEqual(parsed.speechLines, ["哪里的魔族？"]);
  assert.equal(parsed.spoken, true);
  assert.ok(parsed.scene.endsWith("厉声问道"));
  assert.ok(!parsed.scene.includes("哪里的魔族"));
  for (const marker of ["问", "询问", "质问", "回答", "答道", "回应", "喊道", "叫喊"]) {
    const audio = videoPromptAudio(`人物${marker}：“你是谁？”`);
    assert.deepEqual(audio.speechLines, ["你是谁？"], marker);
    assert.ok(!audio.scene.includes("你是谁"), marker);
    assert.equal(audio.spoken, true, marker);
  }
  const conversation = videoPromptAudio("女人问道：你是谁？男人回答：我是旅人。");
  assert.deepEqual(conversation.speechLines, ["你是谁？", "我是旅人。"]);
  for (const scene of ["人物看向门口，目光中带着疑问", "女人抬剑戒备，男人走进客厅", "人物不要问道：你是谁？", "人物不会回答：你好。"]) {
    const audio = videoPromptAudio(scene);
    assert.equal(audio.spoken, false, scene);
    assert.deepEqual(audio.speechLines, [], scene);
  }
  const translatedInputs = [];
  const h = await harness(t, {
    translateScene: async (text) => {
      translatedInputs.push(text);
      return "A woman holds a sword to a man's shoulder in a modern living room and asks sternly.";
    },
  });
  const { response } = await h.request("/api/videos/generate", {
    ...parameters,
    prompt: brief,
    dialogue: "",
  });
  assert.equal(response.status, 202);
  assert.deepEqual(translatedInputs, [parsed.scene]);
  const enginePrompt = h.submitted["5"].inputs.prompt;
  assert.ok(enginePrompt.includes("<d>[CN]哪里的魔族？</d>"));
  assert.ok(enginePrompt.includes("in Mandarin Chinese"));
  assert.ok(!enginePrompt.includes("Where are the devils"));
  assert.equal(/[\u3400-\u9fff]/.test(enginePrompt.replace(/<d>.*?<\/d>/g, "")), false);
  const sung = createVideoWorkflow({
    ...parameters,
    prompt: "人物唱歌：你好，小雅！",
    dialogue: "",
    sceneEnglish: "A woman sings happily.",
  }).workflow["5"].inputs.prompt;
  assert.ok(sung.includes("sings melodically in Mandarin Chinese"));
  assert.ok(sung.includes("<d>[CN]你好，小雅！</d>"));
});

test("Chinese scene conversion excludes lyrics, blocks untranslated directions, and fails before engine submission", async (t) => {
  const brief =
    "场景描述：美女跟随着DJ音乐，跳着欢快的舞蹈，非常的欢快，边跳边唱； 美女唱歌：我的家在东北   ；";
  const parsed = videoPromptAudio(brief);
  assert.deepEqual(parsed.lyrics, ["我的家在东北"]);
  assert.equal(parsed.spoken, false);
  assert.equal(parsed.singing, true);
  assert.ok(!parsed.scene.includes("我的家在东北"));
  assert.ok(!parsed.scene.includes("performing"));
  assert.throws(
    () => createVideoWorkflow({ ...parameters, prompt: brief, dialogue: "" }),
    /必须先转换/,
  );
  const translatedInputs = [];
  const h = await harness(t, {
    translateScene: async (text) => {
      translatedInputs.push(text);
      return "A woman dances energetically to upbeat DJ music, smiling joyfully while singing.";
    },
  });
  const { response, data: job } = await h.request("/api/videos/generate", {
    ...parameters,
    prompt: brief,
    dialogue: "",
    sceneEnglish: "UNTRUSTED OVERRIDE",
  });
  assert.equal(response.status, 202);
  assert.equal(translatedInputs.length, 1);
  assert.ok(!translatedInputs[0].includes("我的家在东北"));
  assert.ok(!job.sceneEnglish.includes("UNTRUSTED"));
  const enginePrompt = h.submitted["5"].inputs.prompt;
  assert.ok(enginePrompt.includes("<d>[CN]我的家在东北</d>"));
  assert.equal(
    /[\u3400-\u9fff]/.test(enginePrompt.replace(/<d>.*?<\/d>/g, "")),
    false,
  );
  const failed = await harness(t, {
    translateScene: async () => {
      throw new Error("Translation unavailable");
    },
  });
  assert.equal(
    (
      await failed.request("/api/videos/generate", {
        ...parameters,
        prompt: brief,
        dialogue: "",
      })
    ).response.status,
    502,
  );
  assert.equal(
    failed.calls.some((call) =>
      ["/prompt", "/upload/image"].includes(call.endpoint),
    ),
    false,
  );
  const untranslated = await harness(t, {
    translateScene: async () => "人物跳舞",
  });
  assert.equal(
    (
      await untranslated.request("/api/videos/generate", {
        ...parameters,
        prompt: brief,
        dialogue: "",
      })
    ).response.status,
    502,
  );
  assert.equal(
    untranslated.calls.some((call) => call.endpoint === "/prompt"),
    false,
  );
});

test("Reference fitting and persisted parameters follow the selected ratio at both qualities", async (t) => {
  const h = await harness(t);
  for (const [quality, ratio, width, height, renderWidth, renderHeight] of [
    ["480P", "9:16", 480, 854, 480, 864],
    ["480P", "1:1", 480, 480, 480, 480],
    ["720P", "9:16", 720, 1280, 736, 1280],
    ["720P", "1:1", 720, 720, 736, 736],
  ]) {
    const { response, data: job } = await h.request("/api/videos/generate", {
      ...parameters,
      quality,
      ratio,
      sourceImage: { name: "managed.png" },
    });
    assert.equal(response.status, 202);
    assert.equal(job.ratio, ratio);
    assert.equal(job.dimensions.finalWidth, width);
    assert.equal(job.dimensions.finalHeight, height);
    assert.equal(h.jobs.get(job.id).ratio, ratio);
    const metadata = await sharp(h.uploaded).metadata();
    assert.equal(metadata.width, renderWidth);
    assert.equal(metadata.height, renderHeight);
    assert.equal(h.submitted["5"].inputs.width, renderWidth);
    assert.equal(h.submitted["5"].inputs.height, renderHeight);
    assert.equal(h.submitted["21"].inputs.width, width);
    assert.equal(h.submitted["21"].inputs.height, height);
  }
});

test("Uploads fitted front-view reference and persists/retrieves the resulting video job", async (t) => {
  const h = await harness(t);
  const { response, data: job } = await h.request("/api/videos/generate", {
    ...parameters,
    quality: "720P",
    framing: "front",
    sourceImage: { name: "managed.png" },
  });
  assert.equal(response.status, 202);
  assert.equal(job.mediaType, "video");
  assert.equal(job.dimensions.finalHeight, 720);
  const metadata = await sharp(h.uploaded).metadata();
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 736);
  assert.deepEqual(h.submitted["5"].inputs.first_frame, ["16", 0]);
  assert.equal((await h.request("/api/videos/jobs")).data.jobs.length, 1);
  h.histories.set(job.id, {
    status: { completed: true },
    outputs: {
      15: {
        images: [
          {
            filename: "test.mp4",
            subfolder: "video\\qwen-workbench",
            type: "output",
          },
        ],
      },
    },
  });
  const finished = (await h.request("/api/videos/jobs/" + job.id)).data;
  assert.equal(finished.status, "completed");
  assert.equal(finished.videoUrl, "/api/videos/media/" + job.id);
  assert.equal(finished.video.subfolder, "video/qwen-workbench");
  assert.equal(h.jobs.get(job.id).status, "completed");
  const media = await h.request(finished.videoUrl + "?download=1", undefined, {
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(media.response.status, 206);
  assert.equal(media.response.headers.get("content-range"), "bytes 0-3/100");
  assert.ok(
    media.response.headers.get("content-disposition").includes("attachment"),
  );
  assert.equal(media.data, "test");
  assert.equal(h.calls.at(-1).options.headers.Range, "bytes=0-3");
});

test("Cancellation only targets this video and survives late status polling", async (t) => {
  const h = await harness(t);
  const { data: job } = await h.request("/api/videos/generate", parameters);
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  let first = true;
  h.statusHook = async () => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
  };
  const lateStatus = h.request("/api/videos/jobs/" + job.id);
  await started;
  const cancelled = await h.request(
    "/api/videos/jobs/" + job.id + "/cancel",
    {},
  );
  assert.equal(cancelled.data.status, "cancelled");
  release();
  assert.equal((await lateStatus).data.status, "cancelled");
  assert.deepEqual(
    h.calls
      .filter((call) => call.endpoint === "/interrupt")
      .map((call) => call.body),
    [{ prompt_id: job.id }],
  );
  assert.deepEqual(
    h.calls.find((call) => call.endpoint === "/queue" && call.body)?.body,
    { delete: [job.id] },
  );
  assert.equal(
    (await h.request("/api/videos/media/" + job.id)).response.status,
    404,
  );
  assert.equal(h.jobs.get(job.id).status, "cancelled");
});

test("Execution failures, interruptions and missing outputs become actionable terminal states", () => {
  assert.equal(
    historyVideo({
      status: {
        messages: [["execution_error", { exception_message: "Out of memory" }]],
      },
    }).error,
    "Out of memory",
  );
  assert.equal(
    historyVideo({ status: { messages: [["execution_interrupted", {}]] } })
      .status,
    "cancelled",
  );
  assert.equal(
    historyVideo({ status: { completed: true }, outputs: {} }).status,
    "failed",
  );
  assert.equal(
    historyVideo({
      status: { completed: true },
      outputs: {
        15: { images: [{ filename: "../secret.mp4", type: "output" }] },
      },
    }).status,
    "failed",
  );
});

test("Project save/import preserves video nodes and restores video records without overwriting live jobs", async (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const previousDirectory = process.env.DATA_DIR;
  const directory = fs.mkdtempSync(
    path.join(require("node:os").tmpdir(), "qwen-video-project-test-"),
  );
  process.env.DATA_DIR = directory;
  const app = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    app.closeStorage();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousDirectory === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDirectory;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = crypto.randomUUID();
  const videoUrl = `/api/videos/media/${id}`;
  const job = {
    id,
    mediaType: "video",
    status: "completed",
    prompt: "A presenter",
    dialogue: "你好",
    quality: "480P",
    ratio: "1:1",
    createdAt: Date.now(),
    videoUrl,
    downloadUrl: videoUrl + "?download=1",
    video: {
      filename: "imported_00001_.mp4",
      subfolder: "video\\qwen-workbench",
      type: "output",
    },
  };
  const project = {
    revision: 0,
    jobs: [],
    videoJobs: [job],
    hiddenJobIds: [],
    board: {
      nodes: [
        {
          id: "generator",
          kind: "video-generator",
          status: "text",
          x: 0,
          y: 0,
          prompt: "",
          dialogue: "你好",
          ratio: "9:16",
          quality: "720P",
          seconds: 6,
          framing: "contain",
        },
        {
          id: "result",
          kind: "video",
          status: "done",
          jobId: id,
          x: 600,
          y: 0,
          url: videoUrl,
          downloadUrl: videoUrl + "?download=1",
        },
      ],
      edges: [
        {
          id: "edge",
          from: "generator",
          to: "result",
          fromSide: "right",
          toSide: "left",
        },
      ],
      pan: { x: 0, y: 0 },
      zoom: 1,
    },
  };
  const save = async (value) =>
    fetch(base + "/api/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  assert.equal((await save(project)).status, 200);
  const restored = await (await fetch(base + "/api/project")).json();
  assert.equal(restored.board.nodes[0].quality, "720P");
  assert.equal(restored.board.nodes[0].ratio, "9:16");
  assert.equal(restored.videoJobs[0].ratio, "1:1");
  assert.equal(restored.board.nodes[1].url, videoUrl);
  assert.equal(restored.board.edges.length, 1);
  const videos = await (await fetch(base + "/api/videos/jobs")).json();
  assert.equal(videos.jobs[0].status, "completed");
  assert.equal(videos.jobs[0].ratio, "1:1");
  assert.equal(videos.jobs[0].video.subfolder, "video/qwen-workbench");
  assert.equal((await (await fetch(base + "/api/jobs")).json()).jobs.length, 0);
  assert.equal(
    (await save({ ...restored, videoJobs: [{ ...job, status: "cancelled" }] }))
      .status,
    200,
  );
  assert.equal(
    (await (await fetch(base + "/api/videos/jobs/" + id)).json()).status,
    "completed",
  );
  const latest = await (await fetch(base + "/api/project")).json();
  for (const ratio of ["16:9", "1:1"]) {
    latest.board.nodes[0].ratio = ratio;
    const response = await save(latest);
    assert.equal(response.status, 200);
    const current = await (await fetch(base + "/api/project")).json();
    assert.equal(current.board.nodes[0].ratio, ratio);
    latest.revision = current.revision;
  }
  latest.board.nodes[0].ratio = "4:3";
  assert.equal((await save(latest)).status, 400);
  latest.board.nodes[0].ratio = "1:1";
  latest.board.nodes[1].url = "https://untrusted/video.mp4";
  assert.equal((await save(latest)).status, 400);
});
