<script setup>
import { reactive, ref, watch, nextTick } from "vue";
import { request, jsonOptions } from "../domain";
import AppIcon from "./AppIcon.vue";
const props = defineProps({ open: Boolean });
const emit = defineEmits(["close"]);
const form = reactive({
  provider: "reuse",
  model: "gpt-6.1-sol",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "",
  removeKey: false,
});
const models = ref([]),
  busy = ref(false),
  error = ref(""),
  current = ref(null),
  panel = ref(),
  closeButton = ref();
let previous;
watch(
  () => props.open,
  async (open) => {
    error.value = "";
    form.apiKey = "";
    form.removeKey = false;
    if (!open) {
      previous?.focus();
      return;
    }
    previous = document.activeElement;
    busy.value = true;
    try {
      current.value = await request("/api/video-prompt-ai/config");
      Object.assign(form, {
        ...current.value,
        model: current.value.model || "gpt-6.1-sol",
      });
    } catch (e) {
      error.value = e.message;
    } finally {
      busy.value = false;
      await nextTick();
      closeButton.value?.focus();
    }
  },
);
async function save(close = true) {
  busy.value = true;
  error.value = "";
  try {
    current.value = await request(
      "/api/video-prompt-ai/config",
      jsonOptions(form),
    );
    form.apiKey = "";
    form.removeKey = false;
    if (close) emit("close");
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}
async function loadModels() {
  if (!(await save(false))) return;
  busy.value = true;
  try {
    models.value = (
      await request("/api/video-prompt-ai/models", {
        signal: AbortSignal.timeout(75000),
      })
    ).models;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function key(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!busy.value) emit("close");
  }
  if (event.key === "Tab") {
    const items = [
      ...panel.value.querySelectorAll("button,input,select"),
    ].filter((e) => !e.disabled && e.getClientRects().length);
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  }
}
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="api-settings-layer"
      @keydown="key"
      @pointerdown.stop
    >
      <div class="api-settings-backdrop" @click="!busy && emit('close')"></div>
      <section
        ref="panel"
        class="api-settings-panel prompt-ai-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-ai-settings-title"
        :aria-busy="busy"
      >
        <header class="api-settings-heading">
          <div>
            <span class="api-settings-kicker">视频提示词</span>
            <h2 id="prompt-ai-settings-title">写词 AI 配置</h2>
            <p>简单描述扩写成表演方案，确认卡片后生成视频。</p>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="icon-button"
            aria-label="关闭写词 AI 配置"
            :disabled="busy"
            @click="emit('close')"
          >
            <AppIcon name="close" />
          </button>
        </header>
        <form @submit.prevent="save(true)">
          <label class="field-label" for="prompt-ai-provider">连接方式</label>
          <select
            id="prompt-ai-provider"
            v-model="form.provider"
            :disabled="busy"
          >
            <option value="reuse">复用生图 API 地址与密钥</option>
            <option value="custom">独立 API / 本地文字模型</option>
          </select>
          <p v-if="form.provider === 'reuse'" class="image-note">
            使用现有生图配置的服务和密钥；文字模型单独选择。{{
              current?.baseUrl
            }}
          </p>
          <template v-else>
            <label class="field-label" for="prompt-ai-url">文字 API 地址</label
            ><input
              id="prompt-ai-url"
              v-model="form.baseUrl"
              type="url"
              required
              :disabled="busy"
              placeholder="http://127.0.0.1:11434/v1"
            />
            <label class="field-label" for="prompt-ai-key">API 密钥</label
            ><input
              id="prompt-ai-key"
              v-model="form.apiKey"
              type="password"
              autocomplete="off"
              :disabled="busy"
              :placeholder="
                current?.keyConfigured
                  ? '已保存，留空保留'
                  : '本地免密服务可留空'
              "
            />
            <label class="prompt-ai-clear"
              ><input
                v-model="form.removeKey"
                type="checkbox"
                :disabled="busy"
              />清除独立配置的已保存密钥</label
            >
          </template>
          <label class="field-label" for="prompt-ai-model">文字模型</label
          ><input
            id="prompt-ai-model"
            v-model="form.model"
            list="prompt-ai-model-list"
            required
            :disabled="busy"
            placeholder="gpt-6.1-sol"
          />
          <datalist id="prompt-ai-model-list">
            <option v-for="model in models" :key="model" :value="model" />
          </datalist>
          <p class="image-note">
            支持兼容 Chat Completions
            的文字服务。扩写仅发送文字描述、台词和视频参数。
          </p>
          <p v-if="error" class="api-settings-error" role="alert">
            {{ error }}
          </p>
          <footer class="api-settings-footer">
            <button
              type="button"
              class="ghost-button"
              :disabled="busy"
              @click="loadModels"
            >
              保存并读取模型列表</button
            ><button type="submit" class="primary-button" :disabled="busy">
              {{ busy ? "处理中…" : "保存写词配置" }}<AppIcon name="arrow" />
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
