<script setup>
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { imageProfile, imageModels } from "../../shared/image-models.mjs";
import { request, jsonOptions } from "../domain";
import AppIcon from "./AppIcon.vue";
const props = defineProps({
  open: Boolean,
  store: Object,
  initialProvider: String,
  embedded: Boolean,
});
const emit = defineEmits(["close", "setup-local"]);
const { s } = props.store;
const panel = ref(),
  first = ref(),
  busy = ref(false),
  provider = ref("local"),
  result = ref(null),
  error = ref("");
const form = reactive({
  baseUrl: "",
  model: "gpt-image-2",
  apiKey: "",
  removeKey: false,
});
let previous;
const modelInfo = computed(() => imageProfile(form.model));
watch(
  () => [props.open, s.ready],
  async ([value]) => {
    form.apiKey = "";
    result.value = null;
    error.value = "";
    if (value) {
      previous = document.activeElement;
      provider.value = props.initialProvider || s.engine.provider;
      Object.assign(form, {
        baseUrl: s.engine.baseUrl,
        model: s.engine.model,
        removeKey: false,
      });
      if (!props.embedded) document.body.classList.add("api-settings-open");
      await nextTick();
      if (!props.embedded) first.value?.focus();
    } else {
      document.body.classList.remove("api-settings-open");
      await nextTick();
      previous?.focus();
    }
  },
  { immediate: true },
);
function close() {
  if (!busy.value) emit("close");
}
function selectProvider(value, event) {
  if (busy.value || !s.ready || s.switching) return;
  provider.value = value;
  event.currentTarget.querySelector(`[data-provider="${value}"]`)?.focus();
}
watch(
  () => [provider.value, form.baseUrl, form.model, form.apiKey, form.removeKey],
  () => {
    result.value = null;
    error.value = "";
  },
);
function key(event) {
  if (props.embedded) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  if (event.key === "Tab") {
    const items = [
      ...panel.value.querySelectorAll("button,input,select,a"),
    ].filter((item) => !item.disabled && item.getClientRects().length);
    const firstItem = items[0],
      lastItem = items.at(-1);
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      lastItem?.focus();
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      firstItem?.focus();
    }
  }
}
async function save(check = false) {
  if (busy.value || !s.ready || s.switching) return;
  if (
    provider.value === "api" &&
    !panel.value.querySelector("form").reportValidity()
  )
    return;
  busy.value = true;
  error.value = "";
  result.value = null;
  try {
    if (provider.value === "local") {
      await props.store.saveEngine({ provider: "local" });
      props.store.toast("已使用本地模型，工作台和画布共用此配置");
      if (!props.embedded) emit("close");
      return;
    }
    await props.store.saveEngine({
      ...form,
      ...(check ? {} : { provider: "api" }),
    });
    form.apiKey = "";
    form.removeKey = false;
    if (check) {
      result.value = await request("/api/engine/check", jsonOptions({}));
      if (result.value.models)
        s.engine.models = imageModels(
          result.value.models.map((model) => model.id),
        );
    } else {
      props.store.toast("API 配置已保存，工作台和画布共用此配置");
      if (!props.embedded) emit("close");
    }
  } catch (failure) {
    error.value = failure.message;
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => document.body.classList.remove("api-settings-open"));
</script>
<template>
  <Teleport to="body" :disabled="embedded">
    <div
      v-if="open"
      class="api-settings-layer"
      :class="{ 'settings-embedded': embedded }"
      @keydown="key"
    >
      <div v-if="!embedded" class="api-settings-backdrop" @click="close"></div>
      <section
        ref="panel"
        class="api-settings-panel"
        :role="embedded ? 'region' : 'dialog'"
        :aria-modal="embedded ? undefined : true"
        aria-labelledby="api-settings-title"
        :aria-busy="busy"
      >
        <header class="api-settings-heading">
          <div>
            <span class="api-settings-kicker">工作台设置</span>
            <h2 id="api-settings-title">生图配置</h2>
            <p>图像工作台与无限画布共用同一套引擎和模型。</p>
          </div>
          <button
            v-if="!embedded"
            type="button"
            class="icon-button"
            ref="first"
            :disabled="busy"
            aria-label="关闭生图配置"
            @click="close"
          >
            <AppIcon name="close" />
          </button>
        </header>
        <div
          class="settings-engine-options"
          role="radiogroup"
          aria-label="配置生图引擎"
          @keydown.left.prevent="selectProvider('local', $event)"
          @keydown.right.prevent="selectProvider('api', $event)"
          @keydown.home.prevent="selectProvider('local', $event)"
          @keydown.end.prevent="selectProvider('api', $event)"
        >
          <button
            v-for="option in ['local', 'api']"
            :key="option"
            type="button"
            role="radio"
            :data-provider="option"
            :tabindex="provider === option ? 0 : -1"
            :aria-checked="provider === option"
            :disabled="busy || !s.ready || s.switching"
            @click="provider = option"
          >
            <strong>{{ option === "local" ? "本地模型" : "API 模型" }}</strong>
            <span>{{
              option === "local"
                ? "Qwen Image 2.1 · ComfyUI"
                : "GPT Image 2 / 2.5 · 云端生成"
            }}</span>
          </button>
        </div>
        <section v-if="provider === 'local'" class="settings-local">
          <h3>在这台电脑上生成</h3>
          <p>
            使用本机显卡和 ComfyUI 运行 Qwen Image
            2.1。换电脑或首次使用时，可检查硬件、安装环境、下载模型并试生成。
          </p>
          <button
            type="button"
            class="ghost-button"
            :disabled="busy || !s.ready || s.switching"
            @click="emit('setup-local')"
          >
            <AppIcon name="settings" />配置本地环境<AppIcon name="arrow" />
          </button>
          <p class="image-note">
            工作台的文生图、图生图，以及画布中的文字节点和参考图编辑均使用此引擎。
          </p>
          <p v-if="error" class="api-settings-error" role="alert">
            {{ error }}
          </p>
          <footer class="api-settings-footer">
            <span class="image-note">保存后用于新提交的任务</span>
            <button
              type="button"
              class="primary-button"
              :disabled="busy || !s.ready || s.switching"
              @click="save(false)"
            >
              {{ busy ? "正在保存…" : "保存并使用本地"
              }}<AppIcon name="arrow" />
            </button>
          </footer>
        </section>
        <form v-else @submit.prevent="save(false)">
          <p class="settings-api-intro">
            无需安装本地模型。填写 API 服务信息后，即可在工作台和画布中生图。
          </p>
          <label class="field-label" for="apiBaseUrl">API 地址</label>
          <input
            id="apiBaseUrl"
            v-model="form.baseUrl"
            type="url"
            required
            :disabled="busy || !s.ready || s.switching"
            placeholder="https://api.openai.com/v1"
            autocomplete="off"
          />
          <p class="image-note">
            填写到 /v1 的完整地址。也可连接兼容 OpenAI Images API 的服务。
          </p>
          <label class="field-label" for="apiModel">生图模型</label>
          <select
            id="apiModel"
            v-model="form.model"
            :disabled="busy || !s.ready || s.switching"
          >
            <option
              v-for="model in s.engine.models"
              :key="model.id"
              :value="model.id"
            >
              {{ model.label }}
            </option>
          </select>
          <p class="image-note">
            {{ modelInfo?.note }} 模型列表中的预置选项不代表当前账户已有权限。
          </p>
          <label class="field-label" for="apiKey"
            >API 密钥
            <span>{{
              s.engine.keyConfigured ? "已配置" : "未配置"
            }}</span></label
          >
          <input
            id="apiKey"
            v-model="form.apiKey"
            type="password"
            :disabled="busy || !s.ready || s.switching || form.removeKey"
            :placeholder="
              s.engine.keyConfigured
                ? '留空保留现有密钥；填入新密钥可替换'
                : '填写该服务的 API Key'
            "
            autocomplete="new-password"
            spellcheck="false"
          />
          <label v-if="s.engine.keySource === 'saved'" class="api-key-clear"
            ><input
              v-model="form.removeKey"
              type="checkbox"
              :disabled="busy || !s.ready || s.switching"
            />清除本机已保存的密钥</label
          >
          <p class="image-note">
            密钥只保存在本机配置，不进入画布、历史记录和项目导出。{{
              s.engine.keySource === "environment"
                ? "当前使用服务器环境变量中的密钥。"
                : ""
            }}
          </p>
          <div class="api-settings-note">
            <AppIcon name="image" />
            <p>
              支持文生图、参考图编辑和文字节点。尺寸与质量原样传给接口，生成结果以服务返回的原图为准。
            </p>
          </div>
          <p v-if="error" class="api-settings-error" role="alert">
            {{ error }}
          </p>
          <div
            v-if="result"
            class="api-connection-result"
            :data-connected="result.connected"
            role="status"
          >
            <strong>{{
              result.connected ? "连接检查通过" : "连接检查未通过"
            }}</strong>
            <p>{{ result.error || result.message }}</p>
            <p v-if="result.availableModels?.length">
              服务提供的生图模型：{{ result.availableModels.join("、") }}
            </p>
            <small v-if="result.connected"
              >模型列表可访问；实际生图权限和费用以服务返回结果为准。</small
            >
          </div>
          <footer class="api-settings-footer">
            <button
              type="button"
              class="ghost-button"
              :disabled="busy || !s.ready || s.switching"
              @click="save(true)"
            >
              {{ busy ? "正在处理…" : "保存并获取模型列表" }}</button
            ><button
              type="submit"
              class="primary-button"
              :disabled="
                busy ||
                !s.ready ||
                s.switching ||
                (!form.apiKey && (!s.engine.keyConfigured || form.removeKey))
              "
            >
              保存并使用 API<AppIcon name="arrow" />
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
