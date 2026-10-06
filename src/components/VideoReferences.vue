<script setup>
import { ref } from "vue";
import SafeImage from "./SafeImage.vue";
import AppIcon from "./AppIcon.vue";
import { videoReferenceRoles } from "../../shared/video-references.mjs";
defineProps({ items: Array, disabled: Boolean, readonly: Boolean });
const emit = defineEmits(["role", "remove", "upload"]);
const picker = ref();
function files(event) {
  const chosen = Array.from(event.target.files || []);
  event.target.value = "";
  if (chosen.length) emit("upload", chosen);
}
</script>
<template>
  <section class="video-references">
    <div class="video-reference-heading">
      <strong>参考图</strong><small>{{ items.length }} / 9</small>
    </div>
    <div class="video-reference-list">
      <div
        v-for="(item, index) in items"
        :key="item.key"
        class="video-reference-item"
      >
        <SafeImage
          :src="item.url"
          :thumbnail="item.thumbnailUrl || item.url + '&thumbnail=1'"
          :alt="'视频参考图 ' + (index + 1)"
        />
        <div>
          <small>参考图 {{ index + 1 }}</small>
          <strong v-if="readonly">{{ item.label }}</strong>
          <select
            v-else
            :value="item.role"
            :aria-label="'参考图' + (index + 1) + '用途'"
            :disabled="disabled"
            @change="emit('role', item.key, $event.target.value)"
          >
            <option
              v-for="(label, role) in videoReferenceRoles"
              :key="role"
              :value="role"
            >
              {{ label }}
            </option>
          </select>
        </div>
        <button
          v-if="!readonly"
          type="button"
          class="quiet-icon"
          :aria-label="'移除视频参考图' + (index + 1)"
          :disabled="disabled"
          @click="emit('remove', item.key)"
        >
          <AppIcon name="close" />
        </button>
      </div>
    </div>
    <template v-if="!readonly">
      <input
        ref="picker"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        @change="files"
      />
      <button
        type="button"
        class="ghost-button video-reference-add"
        :disabled="disabled || items.length >= 9"
        @click="picker.click()"
      >
        ＋ 添加参考图
      </button>
      <p>
        可添加人物图与场景图，也可连接画布图片。多个场景的使用顺序可写在时间分段里。
      </p>
    </template>
    <p v-else>参考图已保留，修改原节点不会改变这张卡片。</p>
  </section>
</template>
