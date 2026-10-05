<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import AppIcon from "./AppIcon.vue";
import SafeImage from "./SafeImage.vue";
import { request, jsonOptions } from "../domain";
import "../setup.css";
const props = defineProps({
  open: Boolean,
  autoCheck: { type: Boolean, default: true },
  returnLabel: { type: String, default: "返回工作台" },
});
const emit = defineEmits(["close", "needs-setup", "changed"]);
const snapshot = ref(null),
  loading = ref(true),
  error = ref(""),
  connectionError = ref(""),
  sending = ref(false),
  step = ref(0),
  panel = ref(),
  closeButton = ref();
const form = reactive({
  comfyBase: "",
  comfyMain: "",
  pythonPath: "",
  comfyUrl: "http://127.0.0.1:8000",
  lowVram: false,
  proxyUrl: "",
});
const installDir = ref(""),
  installMode = ref("new"),
  includeUpscale = ref(false);
const steps = ["检查这台电脑", "配置 ComfyUI", "准备模型", "启动与验证"];
const report = computed(() => snapshot.value?.report);
const task = computed(() => snapshot.value?.task);
const shownError = computed(() => error.value || connectionError.value);
const running = computed(() => task.value?.status === "running");
const disabled = computed(() => running.value || sending.value);
const verification = computed(() => snapshot.value?.verification);
const required = computed(
  () => report.value?.models.filter((model) => !model.optional) || [],
);
const modelsComplete = computed(
  () =>
    required.value.length === 3 &&
    required.value.every((model) => model.complete || model.recognized),
);
const statusLabels = computed(() => [
  report.value ? "已检查" : "待检查",
  report.value?.installed || report.value?.connected ? "可用" : "待配置",
  modelsComplete.value ? "已找到" : "待下载",
  verification.value?.confirmed
    ? "已验证"
    : report.value?.ready
      ? "可试生成"
      : "待启动",
]);
const selectedIds = computed(() => [
  ...required.value.map((item) => item.id),
  ...(includeUpscale.value ? ["upscale"] : []),
]);
const totalBytes = computed(
  () =>
    report.value?.models
      .filter((item) => selectedIds.value.includes(item.id))
      .reduce((sum, item) => sum + item.bytes, 0) || 0,
);
const autoInstall = computed(
  () =>
    report.value?.hardware.platform === "win32" &&
    report.value?.hardware.arch === "x64" &&
    report.value?.hardware.gpus.some((gpu) => /RTX/i.test(gpu.name)),
);
const taskNames = {
  check: "环境检查",
  install: "安装 ComfyUI",
  download: "模型下载",
  checksums: "模型校验",
  start: "启动引擎",
  stop: "停止引擎",
  verify: "试生成",
};
const taskStatuses = {
  running: "进行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
let timer,
  pollVersion = 0,
  disposed = false,
  initialized = false,
  previousFocus;
function size(bytes) {
  if (bytes == null) return "未能读取";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function modelSize(bytes) {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : `${Math.ceil(bytes / 1e6)} MB`;
}
async function refresh(syncForm = false) {
  try {
    const result = await request("/api/setup/status");
    if (disposed) return;
    snapshot.value = result;
    if (!initialized || syncForm) {
      Object.assign(form, result.runtime);
      installDir.value ||= result.suggestedInstallDir;
      installMode.value =
        result.report.installed || result.report.connected ? "existing" : "new";
    }
    if (!initialized && !result.report.ready) emit("needs-setup");
    initialized = true;
    connectionError.value = "";
  } catch (failure) {
    connectionError.value = failure.message;
  } finally {
    loading.value = false;
  }
}
async function poll() {
  const version = ++pollVersion;
  await refresh();
  if (!disposed && version === pollVersion && (props.open || running.value))
    timer = setTimeout(poll, running.value ? 1600 : 8000);
}
async function action(name, data = {}) {
  sending.value = true;
  error.value = "";
  try {
    const result = await request(
      "/api/setup/action",
      jsonOptions({ action: name, ...data }),
    );
    snapshot.value.task = result.task;
    clearTimeout(timer);
    await poll();
    emit("changed");
  } catch (failure) {
    error.value = failure.message;
  } finally {
    sending.value = false;
  }
}
async function save() {
  sending.value = true;
  error.value = "";
  try {
    await request("/api/setup/config", jsonOptions({ ...form }));
    await refresh(true);
    emit("changed");
  } catch (failure) {
    error.value = failure.message;
  } finally {
    sending.value = false;
  }
}
async function cancel() {
  try {
    await request("/api/setup/cancel", jsonOptions({}));
    await refresh();
  } catch (failure) {
    error.value = failure.message;
  }
}
async function confirm() {
  try {
    await request("/api/setup/confirm", jsonOptions({}));
    await refresh();
    emit("changed");
  } catch (failure) {
    error.value = failure.message;
  }
}
function key(event) {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
  if (event.key === "Tab") {
    const controls = [
      ...panel.value.querySelectorAll(
        "button:not(:disabled),a[href],input:not(:disabled),select,summary",
      ),
    ].filter((element) => element.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !panel.value.contains(document.activeElement))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !panel.value.contains(document.activeElement))
    ) {
      event.preventDefault();
      first?.focus();
    }
  }
}
watch(step, async () => {
  await nextTick();
  if (panel.value) panel.value.scrollTop = 0;
});
watch(
  () => props.open,
  async (value) => {
    document.body.classList.toggle("setup-open", value);
    clearTimeout(timer);
    pollVersion++;
    if (value) {
      previousFocus = document.activeElement;
      await nextTick();
      closeButton.value?.focus();
      await poll();
    } else {
      previousFocus?.focus?.();
      if (running.value) timer = setTimeout(poll, 1600);
    }
  },
);
watch(
  () => task.value?.status,
  (value, old) => {
    if (old === "running" && value !== "running") {
      refresh(true);
      emit("changed");
    }
  },
);
onMounted(() => {
  if (props.autoCheck) refresh();
  document.addEventListener("keydown", key, true);
});
watch(
  () => props.autoCheck,
  (value) => {
    if (value && !initialized && !props.open) refresh();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  document.removeEventListener("keydown", key, true);
  document.body.classList.remove("setup-open");
});
</script>
<template>
  <div
    v-if="open"
    class="setup-overlay"
    ref="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="setupTitle"
  >
    <header class="setup-header">
      <div>
        <span class="setup-kicker">本机配置</span>
        <h1 id="setupTitle">让这台电脑开始生成图片</h1>
      </div>
      <button ref="closeButton" class="ghost-button" @click="emit('close')">
        {{ returnLabel }} <AppIcon name="close" />
      </button>
    </header>
    <div class="setup-layout">
      <nav class="setup-sidebar" aria-label="配置步骤">
        <button
          v-for="(title, index) in steps"
          :key="title"
          :class="{ selected: step === index }"
          :aria-current="step === index ? 'step' : undefined"
          @click="step = index"
        >
          <span class="setup-step-number">{{ index + 1 }}</span
          ><span
            >{{ title }}<small>{{ statusLabels[index] }}</small></span
          ><AppIcon
            v-if="index === 3 && verification?.confirmed"
            name="check"
          />
        </button>
        <div class="setup-side-note">
          Qwen-Image 2.1<small
            >模型文件约 14.2 GB<br />本地运行，图片保存在本机</small
          >
        </div>
        <a
          href="https://docs.comfy.org/installation/system_requirements"
          target="_blank"
          rel="noreferrer"
          >官方安装文档 <AppIcon name="arrow"
        /></a>
      </nav>
      <main class="setup-content">
        <div v-if="shownError" class="setup-error" role="alert">
          {{ shownError
          }}<button
            class="ghost-button"
            @click="
              error = '';
              refresh();
            "
          >
            重新检查连接
          </button>
        </div>
        <p v-if="loading" class="setup-loading">正在读取电脑信息与引擎状态…</p>
        <template v-else-if="report">
          <section v-if="step === 0">
            <div class="setup-section-title">
              <div>
                <h2>先看看电脑是否具备运行条件</h2>
                <p>
                  识别硬件、驱动、模型和节点。能否稳定运行，以最后的试生成结果为准。
                </p>
              </div>
              <button
                class="ghost-button"
                :disabled="disabled"
                @click="action('check')"
              >
                <AppIcon name="refresh" />重新检测
              </button>
            </div>
            <div class="setup-hardware">
              <article>
                <span>显卡与驱动</span
                ><strong>{{
                  report.hardware.gpus[0]?.name ||
                  report.engine?.devices?.[0]?.name ||
                  "未识别 NVIDIA 显卡"
                }}</strong
                ><small v-if="report.hardware.gpus.length"
                  >{{ size(report.hardware.gpus[0].vram) }} 显存 · 驱动
                  {{ report.hardware.gpus[0].driver }}</small
                ><small v-else>{{ report.hardware.gpuError }}</small>
              </article>
              <article>
                <span>系统内存</span
                ><strong>{{ size(report.hardware.ram) }}</strong
                ><small>建议 32 GB 或更多，低显存模式需要系统内存</small>
              </article>
              <article>
                <span>安装盘可用空间</span
                ><strong>{{ size(report.freeDisk) }}</strong
                ><small>新安装建议至少预留 25 GB，图片还会占用额外空间</small>
              </article>
              <article>
                <span>工作台运行环境</span
                ><strong>Node.js {{ report.hardware.node }}</strong
                ><small
                  >{{ report.hardware.platform }} / {{ report.hardware.arch }} ·
                  {{ report.hardware.cpu }}</small
                >
              </article>
            </div>
            <div class="setup-check-list">
              <div>
                <span>ComfyUI</span
                ><strong
                  :class="report.connected ? 'setup-good' : 'setup-muted'"
                  >{{
                    report.connected
                      ? `已连接 · ${report.engine.version}`
                      : "未连接"
                  }}</strong
                >
              </div>
              <div>
                <span>Python 与 PyTorch</span
                ><strong>{{
                  report.torch?.version ||
                  report.engine?.pytorch ||
                  (report.installed
                    ? "已找到 Python，点击重新检测运行检查"
                    : "安装便携版后自动包含")
                }}</strong>
              </div>
              <div>
                <span>CUDA 实际运算</span
                ><strong
                  :class="report.torch?.kernelOk ? 'setup-good' : 'setup-muted'"
                  >{{
                    report.torch?.kernelOk
                      ? "已通过一次 GPU 运算"
                      : report.torch?.error ||
                        (report.torch
                          ? "CUDA 不可用，请检查 NVIDIA 驱动"
                          : "尚未执行，点击重新检测")
                  }}</strong
                >
              </div>
              <div>
                <span>Qwen 必需节点</span
                ><strong
                  :class="
                    !report.missingNodes.length ? 'setup-good' : 'setup-muted'
                  "
                  >{{
                    report.connected
                      ? report.missingNodes.length
                        ? `缺少 ${report.missingNodes.length} 个`
                        : "全部可用"
                      : "启动引擎后检查"
                  }}</strong
                >
              </div>
            </div>
            <div v-if="report.warnings.length" class="setup-advice">
              <p v-for="warning in report.warnings" :key="warning">
                {{ warning }}
              </p>
            </div>
            <p class="setup-footnote">
              8 GB 显存属于需要实测的配置；12 GB
              及以上有更多余量。这里是工作台的经验建议，不是模型官方的最低保证。AMD、Intel、Mac
              可连接已有 ComfyUI，当前自动安装与试生成向导面向 Windows /
              NVIDIA。
            </p>
            <div class="setup-bottom">
              <button class="primary-button" @click="step = 1">
                配置 ComfyUI <AppIcon name="arrow" />
              </button>
            </div>
          </section>
          <section v-else-if="step === 1">
            <div class="setup-section-title">
              <div>
                <h2>安装引擎，或连接已有安装</h2>
                <p>本机路径只保存在这台电脑，不会写回项目默认配置。</p>
              </div>
            </div>
            <div class="setup-mode" role="tablist" aria-label="安装方式">
              <button
                role="tab"
                :aria-selected="installMode === 'new'"
                :class="{ selected: installMode === 'new' }"
                @click="installMode = 'new'"
              >
                这台电脑还没安装</button
              ><button
                role="tab"
                :aria-selected="installMode === 'existing'"
                :class="{ selected: installMode === 'existing' }"
                @click="installMode = 'existing'"
              >
                使用已有 ComfyUI
              </button>
            </div>
            <details class="setup-network">
              <summary>下载网络设置 · 无法访问模型网站时配置</summary>
              <label class="setup-field"
                >本机下载代理（可选）<input
                  v-model="form.proxyUrl"
                  :disabled="disabled"
                  placeholder="例如 http://127.0.0.1:7890，直接联网则留空"
                  autocomplete="off"
                  spellcheck="false"
                /><small
                  >用于访问 GitHub 与 Hugging Face。本机 ComfyUI
                  不经过代理；留空时沿用启动环境的代理变量。</small
                ></label
              ><button class="ghost-button" :disabled="disabled" @click="save">
                保存代理设置
              </button>
            </details>
            <div v-if="installMode === 'new'" class="setup-install-card">
              <div class="setup-inline-title">
                <AppIcon name="download" />
                <div>
                  <h3>官方 Windows 便携版</h3>
                  <p>包含 Python、PyTorch 和 ComfyUI，无需分别安装。</p>
                </div>
                <span class="setup-tag"
                  >v{{ snapshot.manifest.comfyVersion }}</span
                >
              </div>
              <label class="setup-field"
                >安装到哪个文件夹<input
                  v-model="installDir"
                  :disabled="disabled"
                  autocomplete="off"
                  spellcheck="false"
                /><small
                  >会在这里新建
                  ComfyUI_windows_portable；已有文件不会被覆盖。</small
                ></label
              >
              <div v-if="!autoInstall" class="setup-advice">
                <p>
                  自动安装需要 Windows x64 和 NVIDIA RTX
                  显卡。请从下方官方入口下载与你的硬件匹配的安装包，完成后使用“已有
                  ComfyUI”。
                </p>
              </div>
              <p class="setup-footnote">
                安装包约 2 GB，解压后需要更多空间。解压工具从 7-Zip
                官方仓库下载，两者都会核对
                SHA-256。中断解压的临时目录会保留，可手动移走。
              </p>
              <div class="setup-inline-actions">
                <button
                  class="primary-button"
                  :disabled="disabled || !autoInstall || !installDir.trim()"
                  @click="action('install', { directory: installDir })"
                >
                  下载并安装</button
                ><a
                  href="https://docs.comfy.org/installation/comfyui_portable_windows"
                  target="_blank"
                  rel="noreferrer"
                  >查看官方安装方式 <AppIcon name="arrow"
                /></a>
              </div>
            </div>
            <form v-else class="setup-path-form" @submit.prevent="save">
              <label class="setup-field"
                >ComfyUI 服务地址<input
                  v-model="form.comfyUrl"
                  :disabled="disabled"
                  required
                  autocomplete="off"
                  spellcheck="false"
                /><small
                  >便携版通常为 http://127.0.0.1:8188；工作台自动启动默认使用
                  8000。</small
                ></label
              >
              <label class="setup-field"
                >数据目录<input
                  v-model="form.comfyBase"
                  :disabled="disabled"
                  required
                  autocomplete="off"
                  spellcheck="false"
                /><small
                  >包含 models、input、output
                  的文件夹。桌面版的数据目录可能与程序目录不同。</small
                ></label
              >
              <div class="setup-two-fields">
                <label class="setup-field"
                  >ComfyUI 的 main.py<input
                    v-model="form.comfyMain"
                    :disabled="disabled"
                    required
                    autocomplete="off"
                    spellcheck="false" /></label
                ><label class="setup-field"
                  >运行 ComfyUI 的 python.exe<input
                    v-model="form.pythonPath"
                    :disabled="disabled"
                    required
                    autocomplete="off"
                    spellcheck="false"
                /></label>
              </div>
              <label class="setup-checkbox"
                ><input
                  v-model="form.lowVram"
                  type="checkbox"
                  :disabled="disabled"
                />低显存模式<small
                  >下次由工作台启动时生效，会增加系统内存占用和推理时间。</small
                ></label
              >
              <button class="primary-button" :disabled="disabled">
                保存并检查
              </button>
            </form>
            <div class="setup-bottom">
              <span>{{
                report.installed
                  ? "已找到本机安装"
                  : report.connected
                    ? "已有服务可连接"
                    : "安装完成后继续"
              }}</span
              ><button class="ghost-button" @click="step = 2">
                准备模型 <AppIcon name="arrow" />
              </button>
            </div>
          </section>
          <section v-else-if="step === 2">
            <div class="setup-section-title">
              <div>
                <h2>下载模型，放到正确位置</h2>
                <p>
                  三个必需文件来自
                  Comfy-Org。下载后自动校验，已下载的内容可继续使用。
                </p>
              </div>
            </div>
            <div class="setup-model-list">
              <article
                v-for="model in report.models"
                :key="model.id"
                class="setup-model"
              >
                <div class="setup-model-title">
                  <strong>{{ model.label }}</strong
                  ><span v-if="model.optional" class="setup-tag"
                    >可选 · 超分</span
                  ><span
                    class="setup-model-state"
                    :class="
                      model.verified || model.recognized
                        ? 'setup-good'
                        : 'setup-muted'
                    "
                    >{{
                      model.verified
                        ? "SHA-256 已验证"
                        : model.recognized
                          ? "引擎已识别，尚未校验"
                          : model.complete
                            ? "文件已找到，尚未校验"
                            : model.present
                              ? "文件长度不匹配"
                              : model.partialBytes
                                ? "有未完成下载"
                                : "未找到"
                    }}</span
                  >
                </div>
                <code>{{ model.filename }}</code>
                <p>{{ modelSize(model.bytes) }} · {{ model.license }}</p>
                <small class="setup-model-path">{{ model.path }}</small>
                <div class="setup-model-links">
                  <a :href="model.source" target="_blank" rel="noreferrer"
                    >模型来源与许可</a
                  ><a :href="model.url" target="_blank" rel="noreferrer"
                    >手动下载</a
                  ><button
                    class="ghost-button"
                    :disabled="
                      disabled || !report.installed || !model.downloadable
                    "
                    @click="action('download', { modelIds: [model.id] })"
                  >
                    {{
                      model.partialBytes
                        ? "继续下载"
                        : model.complete
                          ? "核对已有文件"
                          : "下载这个文件"
                    }}
                  </button>
                </div>
              </article>
            </div>
            <label class="setup-checkbox"
              ><input
                v-model="includeUpscale"
                type="checkbox"
                :disabled="disabled"
              />同时下载可选超分模型<small
                >只用于超分档；普通生成不需要它。UltraSharp
                为非商业许可，请先阅读模型来源。</small
              ></label
            >
            <div class="setup-inline-actions">
              <button
                class="primary-button"
                :disabled="disabled || !report.installed"
                @click="action('download', { modelIds: selectedIds })"
              >
                <AppIcon name="download" />下载并校验 ·
                {{ modelSize(totalBytes) }}</button
              ><button
                class="ghost-button"
                :disabled="disabled || !report.installed || !modelsComplete"
                @click="action('checksums', { modelIds: selectedIds })"
              >
                校验已有模型
              </button>
            </div>
            <p class="setup-footnote">
              自动下载不会覆盖不同版本的文件。若校验失败，请把损坏文件移到备份目录后重试。手动下载也可以，但文件名和目录必须与上方一致。外部模型目录可通过已有
              ComfyUI 的 extra_model_paths 配置连接。
            </p>
            <div class="setup-bottom">
              <button class="ghost-button" @click="step = 1">上一步</button
              ><button class="primary-button" @click="step = 3">
                启动与验证 <AppIcon name="arrow" />
              </button>
            </div>
          </section>
          <section v-else>
            <div class="setup-section-title">
              <div>
                <h2>运行模型，确认真的能出图</h2>
                <p>先确认引擎和模型就绪，再生成一张 1024 × 1024 的产品图片。</p>
              </div>
              <span
                class="setup-tag"
                :class="report.ready ? 'setup-good' : ''"
                >{{ report.ready ? "模型与节点就绪" : "需要完成配置" }}</span
              >
            </div>
            <div class="setup-engine-card">
              <span
                class="status-dot"
                :class="{ online: report.connected }"
              ></span>
              <div>
                <strong>{{
                  report.connected ? "ComfyUI 已连接" : "ComfyUI 未连接"
                }}</strong>
                <p>
                  {{ form.comfyUrl
                  }}<template v-if="report.engine">
                    · {{ report.engine.version }}</template
                  >
                </p>
              </div>
              <button
                class="ghost-button"
                :disabled="disabled"
                @click="action('check')"
              >
                重新检查
              </button>
            </div>
            <div v-if="report.engineError" class="setup-advice">
              <p>{{ report.engineError }}</p>
            </div>
            <div
              v-if="report.connected && report.missingNodes.length"
              class="setup-advice"
            >
              <p>
                缺少节点：{{ report.missingNodes.join("、") }}。请升级已有
                ComfyUI，或安装官方便携版。
              </p>
            </div>
            <div class="setup-inline-actions">
              <button
                class="primary-button"
                :disabled="disabled || (!report.installed && !report.connected)"
                @click="action('start')"
              >
                {{
                  report.connected ? "连接已运行引擎" : "启动 ComfyUI"
                }}</button
              ><button
                class="ghost-button"
                :disabled="disabled || !snapshot.managed"
                @click="action('stop')"
              >
                停止工作台启动的引擎
              </button>
            </div>
            <p class="setup-footnote">
              工作台启动的引擎仅监听本机。由桌面版或其他终端启动的服务，请在原程序中停止。不要在生成过程中关闭服务。
            </p>
            <div class="setup-verification">
              <div>
                <h3>
                  {{
                    verification?.confirmed
                      ? "这台电脑已通过出图验证"
                      : "试生成一张图片"
                  }}
                </h3>
                <p>
                  红色陶瓷杯、浅灰桌面、产品摄影。使用当前模型、真实工作流和 25
                  步采样，首次加载可能需要几分钟。
                </p>
                <button
                  class="primary-button"
                  :disabled="disabled || !report.ready"
                  @click="action('verify')"
                >
                  {{
                    verification?.status === "passed"
                      ? "重新试生成"
                      : "开始试生成"
                  }}
                  <AppIcon name="arrow" />
                </button>
                <p
                  v-if="
                    verification?.status === 'failed' ||
                    verification?.status === 'cancelled'
                  "
                  class="setup-error"
                >
                  {{ verification.error || "本次验证已取消" }}
                </p>
                <template v-if="verification?.status === 'passed'"
                  ><p class="setup-good">
                    图片已生成并成功解码 · {{ verification.width }} ×
                    {{ verification.height }} ·
                    {{ Math.round(verification.elapsedMs / 1000) }} 秒
                  </p>
                  <button
                    v-if="!verification.confirmed"
                    class="ghost-button"
                    @click="confirm"
                  >
                    我已查看，图片内容正常</button
                  ><button v-else class="ghost-button" @click="emit('close')">
                    进入工作台
                  </button></template
                >
              </div>
              <SafeImage
                v-if="verification?.imageUrl"
                :src="verification.imageUrl"
                alt="配置验证生成的红色陶瓷杯"
                class="setup-proof-image"
              />
              <div v-else class="setup-proof-empty">
                <AppIcon name="image" /><span>试生成结果会显示在这里</span>
              </div>
            </div>
            <details class="setup-engine-log">
              <summary>引擎日志 · 启动失败时查看</summary>
              <pre>{{
                snapshot.engineLog ||
                "当前没有工作台启动的引擎日志。外部引擎请查看原启动窗口。"
              }}</pre>
            </details>
          </section>
          <aside
            v-if="task"
            class="setup-task"
            :data-state="task.status"
            role="status"
            aria-live="polite"
          >
            <div class="setup-task-header">
              <strong
                >{{ taskNames[task.kind] }} ·
                {{ taskStatuses[task.status] }}</strong
              ><span v-if="running && task.progress != null"
                >{{ Math.min(100, Math.round(task.progress * 100)) }}%</span
              ><button v-if="running" class="ghost-button" @click="cancel">
                取消操作
              </button>
            </div>
            <div v-if="running" class="setup-progress">
              <span
                :class="{ indeterminate: task.progress == null }"
                :style="
                  task.progress != null
                    ? { width: `${Math.min(100, task.progress * 100)}%` }
                    : {}
                "
              ></span>
            </div>
            <p>{{ task.message }}</p>
            <small v-if="running && task.phase === 'downloading'"
              >{{ modelSize(task.downloaded) }} / {{ modelSize(task.total) }} ·
              关闭配置界面后仍会继续下载</small
            >
            <details>
              <summary>操作详情</summary>
              <pre>{{
                task.logs
                  .map(
                    (line) =>
                      `${new Date(line.time).toLocaleTimeString()}  ${line.text}`,
                  )
                  .join("\n")
              }}</pre>
            </details>
          </aside>
        </template>
      </main>
    </div>
    <div v-if="running" class="setup-running-bar" role="status">
      <span
        >{{ taskNames[task.kind]
        }}<small>{{
          task.phase === "hashing"
            ? "正在校验文件"
            : task.phase === "extracting"
              ? "正在解压"
              : task.message
        }}</small></span
      ><strong v-if="task.progress != null"
        >{{ Math.min(100, Math.round(task.progress * 100)) }}%</strong
      ><button class="ghost-button" @click="cancel">取消当前操作</button>
    </div>
  </div>
</template>
