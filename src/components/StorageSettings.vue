<script setup>
import { ref, onMounted } from "vue";
import AppIcon from "./AppIcon.vue";
import { request, jsonOptions } from "../domain";
const props = defineProps({ store: Object });
const directory = ref(""),
  settings = ref(null),
  busy = ref(false),
  error = ref(""),
  saved = ref(false);
onMounted(async () => {
  busy.value = true;
  try {
    settings.value = await request("/api/settings");
    directory.value = settings.value.imageOutputDir;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
});
async function choose() {
  busy.value = true;
  error.value = "";
  try {
    const result = await request("/api/settings/choose-directory", {
      ...jsonOptions({}),
      signal: AbortSignal.timeout(190000),
    });
    if (result.directory) {
      directory.value = result.directory;
      saved.value = false;
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  busy.value = true;
  error.value = "";
  saved.value = false;
  try {
    settings.value = await request(
      "/api/settings",
      jsonOptions({ imageOutputDir: directory.value }, "PUT"),
    );
    directory.value = settings.value.imageOutputDir;
    saved.value = true;
    props.store.toast("图片保存位置已更新，新提交的图片会自动保存");
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="storage-settings api-settings-panel">
    <header class="api-settings-heading">
      <div>
        <span class="api-settings-kicker">文件存储</span>
        <h2>生成图片的保存位置</h2>
        <p>本地模型和 API 生成的图片，自动保存到同一个文件夹。</p>
      </div>
    </header>
    <form @submit.prevent="save">
      <label class="field-label" for="imageOutputDir">默认保存文件夹</label>
      <div class="storage-path-field">
        <input
          id="imageOutputDir"
          v-model="directory"
          required
          :disabled="busy"
          placeholder="输入完整文件夹路径"
          @input="saved = false"
        /><button
          v-if="settings?.folderPicker"
          type="button"
          class="ghost-button"
          :disabled="busy"
          @click="choose"
        >
          <AppIcon name="folder" />选择文件夹
        </button>
      </div>
      <p class="settings-storage-note">
        设置对新提交的图片生效，工作台和所有项目画布共用。已有图片保持原来的位置，仍可在素材库中查看。
      </p>
      <p v-if="error" class="api-settings-error" role="alert">{{ error }}</p>
      <p v-if="saved" class="settings-save-success" role="status">
        保存成功，文件夹已通过写入检查。
      </p>
      <footer class="api-settings-footer">
        <button
          type="button"
          class="ghost-button"
          :disabled="busy || !settings"
          @click="
            directory = settings.defaultDirectory;
            saved = false;
          "
        >
          恢复默认路径</button
        ><button
          id="saveStorageSettings"
          class="primary-button"
          :disabled="busy || !directory.trim()"
        >
          {{ busy ? "正在处理…" : "保存位置" }}<AppIcon name="check" />
        </button>
      </footer>
    </form>
  </section>
</template>
