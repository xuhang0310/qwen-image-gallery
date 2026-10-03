<script setup>
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({ store: Object });
const { s } = props.store;
const f = s.form;
const dims = computed(() => s.config.ratios[f.ratio][f.quality]);
const activeCount = computed(
  () =>
    s.jobs.filter((job) => ["queued", "running"].includes(job.status)).length,
);
const disabled = computed(
  () =>
    !s.ready ||
    props.store.busy() ||
    (f.mode === "img2img" && (f.uploading || !f.sourceImage)),
);
function file(event) {
  props.store.upload(event.target.files[0]);
  event.target.value = "";
}
function toggleSeed() {
  f.fixedSeed = !f.fixedSeed;
  if (f.fixedSeed && f.seed === "")
    f.seed = Math.floor(Math.random() * 2147483647);
}
function randomSeed() {
  f.fixedSeed = true;
  f.seed = Math.floor(Math.random() * 2147483647);
}
</script>
<template>
  <aside class="control-panel panel">
    <div class="panel-heading">
      <div>
        <h1>生成图片</h1>
      </div>
    </div>
    <form id="generateForm" @submit.prevent="store.submitForm">
      <div
        id="modeOptions"
        class="mode-options"
        role="radiogroup"
        aria-label="生成模式"
      >
        <button
          v-for="mode in ['txt2img', 'img2img']"
          :key="mode"
          type="button"
          class="choice-card"
          :class="{ 'is-selected': f.mode === mode }"
          :data-mode="mode"
          role="radio"
          :aria-checked="f.mode === mode"
          @click="f.mode = mode"
        >
          {{ mode === "txt2img" ? "文生图" : "图生图" }}
        </button>
      </div>
      <section
        id="imageControls"
        class="image-controls"
        :class="{ hidden: f.mode !== 'img2img' }"
      >
        <label class="field-label" for="sourceFile"
          >上传原图 <span>PNG / JPEG / WebP · ≤10MB</span></label
        ><input
          id="sourceFile"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change="file"
        />
        <div
          id="sourcePreview"
          class="source-preview"
          :class="{ hidden: !f.sourceImage }"
        >
          <img
            id="sourceImage"
            :src="f.sourceImage ? store.sourceUrl(f.sourceImage) : undefined"
            alt="图生图原图预览"
          />
          <div>
            <span id="sourceInfo"
              >{{ f.sourceImage?.width }} × {{ f.sourceImage?.height }} px</span
            ><button
              id="removeSource"
              type="button"
              @click="store.removeSource"
            >
              移除原图
            </button>
          </div>
        </div>
        <p id="uploadStatus" class="image-note" role="status">
          {{ f.uploadStatus }}
        </p>
        <p class="image-note">
          描述要修改和保留的内容。原图按所选比例居中裁切。
        </p>
      </section>
      <label class="field-label" for="prompt">提示词 <span>必填</span></label>
      <div class="prompt-wrap">
        <textarea
          id="prompt"
          v-model="f.prompt"
          maxlength="4000"
          placeholder="描述主体、构图、光线与想保留的细节…"
          required
        ></textarea>
        <div class="prompt-foot">
          <span id="promptCount">{{ f.prompt.length }} / 4000</span
          ><span>中文 / English</span>
        </div>
      </div>
      <details class="negative-details">
        <summary>
          <span>反向提示词</span
          ><span class="summary-hint">排除不想出现的内容 ⌄</span>
        </summary>
        <textarea
          id="negativePrompt"
          v-model="f.negativePrompt"
          maxlength="2000"
          placeholder="例如：文字、水印、模糊"
        ></textarea>
        <p class="image-note">
          填写后启用增强引导，生成时间和显存占用可能增加。
        </p>
      </details>
      <section class="option-section">
        <div class="section-label-row">
          <label class="field-label">画面比例</label
          ><span id="ratioHint">{{ s.config.ratios[f.ratio].hint }}</span>
        </div>
        <div
          id="ratioOptions"
          class="segmented-grid ratio-grid"
          role="radiogroup"
          aria-label="画面比例"
        >
          <button
            v-for="ratio in ['9:16', '1:1', '16:9', '4:3', '3:4', '3:2']"
            :key="ratio"
            type="button"
            class="choice-card"
            :class="{ 'is-selected': f.ratio === ratio }"
            :data-ratio="ratio"
            role="radio"
            :aria-checked="f.ratio === ratio"
            @click="f.ratio = ratio"
          >
            <span
              class="ratio-icon"
              :class="'ratio-' + ratio.replace(':', '')"
            ></span
            ><strong>{{ ratio }}</strong
            ><small>{{ s.config.ratios[ratio].label }}</small>
          </button>
        </div>
      </section>
      <section class="option-section quality-section">
        <div class="section-label-row">
          <label class="field-label">输出质量</label
          ><span id="qualityHint">{{
            s.config.qualities[f.quality].hint
          }}</span>
        </div>
        <div
          id="qualityOptions"
          class="quality-options"
          role="radiogroup"
          aria-label="输出质量"
        >
          <button
            v-for="(quality, key) in s.config.qualities"
            :key="key"
            type="button"
            class="quality-card"
            :class="{ 'is-selected': f.quality === key }"
            :data-quality="key"
            role="radio"
            :aria-checked="f.quality === key"
            @click="f.quality = key"
          >
            <strong>{{ quality.label }}</strong
            ><span>{{ key === "4K" ? "生成后超分" : "原生生成" }}</span
            ><i>{{
              key === "1K"
                ? "1024 px"
                : key === "2K"
                  ? "约 1.5–1.7K"
                  : "最长边 3840–4096"
            }}</i>
          </button>
        </div>
      </section>
      <div class="output-summary">
        <div class="summary-icon"><AppIcon name="image" /></div>
        <div>
          <span>预计输出</span
          ><strong id="dimensionText"
            >{{ dims[0].toLocaleString() }} ×
            {{ dims[1].toLocaleString() }} px</strong
          >
        </div>
        <span id="summaryTag" class="summary-tag"
          >{{ f.ratio }} · {{ s.config.qualities[f.quality].label }}</span
        >
      </div>
      <div class="seed-row">
        <label class="field-label" for="seed">随机种子</label>
        <div class="seed-input-wrap">
          <input
            id="seed"
            v-model="f.seed"
            type="number"
            min="0"
            max="2147483647"
            step="1"
            :required="f.fixedSeed"
            placeholder="随机"
            :disabled="!f.fixedSeed"
          /><button
            id="seedToggle"
            type="button"
            class="seed-toggle"
            :aria-pressed="f.fixedSeed"
            @click="toggleSeed"
          >
            固定</button
          ><button
            id="randomSeed"
            type="button"
            class="dice-button"
            aria-label="生成随机种子"
            @click="randomSeed"
          >
            ⚄
          </button>
        </div>
      </div>
      <div class="generate-sticky">
        <button
          id="generateButton"
          class="generate-button"
          type="submit"
          :disabled="disabled"
        >
          <span>{{
            s.submitting
              ? "正在提交…"
              : activeCount
                ? "继续添加任务"
                : "生成图片"
          }}</span
          ><AppIcon name="arrow" />
        </button>
        <p class="shortcut-hint">
          {{
            activeCount
              ? `${activeCount} 个任务进行中，可继续提交`
              : "Ctrl / ⌘ + Enter 快速生成"
          }}
        </p>
      </div>
    </form>
  </aside>
</template>
