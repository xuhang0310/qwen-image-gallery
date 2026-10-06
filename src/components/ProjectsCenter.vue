<script setup>
import { ref, computed, nextTick } from "vue";
import AppIcon from "./AppIcon.vue";
import SafeImage from "./SafeImage.vue";
const props = defineProps({ store: Object });
defineEmits(["import"]);
const { s } = props.store;
const search = ref(""),
  creating = ref(false),
  name = ref(""),
  nameInput = ref(),
  busy = ref(false),
  renaming = ref(null),
  rename = ref(""),
  deleting = ref(null);
const projects = computed(() =>
  [...s.projects]
    .filter((p) => p.name.toLowerCase().includes(search.value.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt),
);
const date = (value) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
async function startCreate() {
  creating.value = true;
  name.value = "";
  await nextTick();
  nameInput.value?.focus();
}
async function create() {
  if (!name.value.trim() || busy.value) return;
  busy.value = true;
  try {
    if (await props.store.createProject(name.value.trim()))
      creating.value = false;
  } finally {
    busy.value = false;
  }
}
async function saveName(id) {
  busy.value = true;
  try {
    if (await props.store.renameProject(id, rename.value))
      renaming.value = null;
  } finally {
    busy.value = false;
  }
}
async function remove(id) {
  busy.value = true;
  try {
    if (await props.store.deleteProject(id)) deleting.value = null;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main class="projects-page">
    <div class="page-intro">
      <div>
        <h2>你的项目</h2>
        <p>每个项目拥有独立画布，图片和视频可以从素材库复用。</p>
      </div>
      <div class="page-tools">
        <button
          id="exportProject"
          class="ghost-button"
          :disabled="busy || !s.ready"
          @click="store.exportProject"
        >
          <AppIcon name="download" />导出当前项目
        </button>
        <button
          id="importProject"
          class="ghost-button"
          :disabled="busy || !s.ready"
          @click="$emit('import')"
        >
          <AppIcon name="upload" />导入项目</button
        ><button
          id="createProject"
          class="primary-button"
          :disabled="busy || !s.ready"
          @click="startCreate"
        >
          <AppIcon name="plus" />新建项目
        </button>
      </div>
    </div>
    <form v-if="creating" class="project-create-form" @submit.prevent="create">
      <label for="projectName">项目名称</label
      ><input
        id="projectName"
        ref="nameInput"
        v-model="name"
        maxlength="80"
        placeholder="例如：秋季产品图"
        required
        :disabled="busy"
      /><button class="primary-button" :disabled="busy || !name.trim()">
        {{ busy ? "正在创建…" : "创建并打开画布" }}</button
      ><button
        type="button"
        class="ghost-button"
        :disabled="busy"
        @click="creating = false"
      >
        取消
      </button>
    </form>
    <div class="project-list-toolbar">
      <span>{{ s.projects.length }} 个项目</span
      ><input
        v-model="search"
        class="project-search"
        aria-label="搜索项目"
        placeholder="搜索项目名称"
      />
    </div>
    <div v-if="!projects.length" class="projects-empty">
      {{ search ? "没有找到匹配的项目" : "还没有项目，创建一个开始创作。" }}
    </div>
    <div class="project-grid">
      <article
        v-for="project in projects"
        :key="project.id"
        class="project-card"
        :data-project-id="project.id"
        :class="{ 'is-current': s.currentProject.id === project.id }"
      >
        <button
          class="project-cover"
          :disabled="busy || s.projectBusy"
          :aria-label="'打开项目 ' + project.name"
          @click="store.openProject(project.id)"
        >
          <SafeImage
            v-if="project.coverUrl"
            :src="project.coverUrl"
            :thumbnail="project.coverUrl"
            alt=""
            loading="lazy"
          /><span v-else class="project-cover-grid"
            ><AppIcon name="grid" /><span>{{
              project.nodeCount ? project.nodeCount + " 个创作节点" : "空白画布"
            }}</span></span
          ><span
            v-if="s.currentProject.id === project.id"
            class="project-current-badge"
            >当前项目</span
          >
        </button>
        <div class="project-card-body">
          <form
            v-if="renaming === project.id"
            class="project-rename"
            @submit.prevent="saveName(project.id)"
          >
            <input
              v-model="rename"
              aria-label="新的项目名称"
              maxlength="80"
              required
            /><button
              class="icon-button"
              :disabled="busy || !rename.trim()"
              aria-label="保存项目名称"
            >
              <AppIcon name="check" /></button
            ><button
              type="button"
              class="icon-button"
              @click="renaming = null"
              aria-label="取消重命名"
            >
              <AppIcon name="close" />
            </button>
          </form>
          <h3 v-else>{{ project.name }}</h3>
          <div class="project-card-meta">
            <span>{{ project.nodeCount }} 个节点</span
            ><span
              >{{ project.imageCount }} 张图片 ·
              {{ project.videoCount }} 个视频</span
            >
          </div>
          <time>{{ date(project.updatedAt) }} 更新</time>
          <div class="project-card-actions">
            <button
              class="ghost-button"
              :disabled="busy || s.projectBusy"
              @click="store.openProject(project.id)"
            >
              打开画布<AppIcon name="arrow" /></button
            ><button
              class="icon-button"
              title="重命名"
              aria-label="重命名项目"
              :disabled="busy"
              @click="
                renaming = project.id;
                rename = project.name;
              "
            >
              <AppIcon name="edit" /></button
            ><button
              class="icon-button"
              title="删除项目"
              aria-label="删除项目"
              :disabled="busy || s.projects.length < 2"
              @click="deleting = project.id"
            >
              <AppIcon name="trash" />
            </button>
          </div>
          <div v-if="deleting === project.id" class="project-delete-confirm">
            <strong>删除“{{ project.name }}”？</strong>
            <p>项目画布会删除，素材和生成记录保留。</p>
            <button
              class="ghost-button"
              :disabled="busy"
              @click="deleting = null"
            >
              取消</button
            ><button
              class="danger-button"
              :disabled="busy"
              @click="remove(project.id)"
            >
              删除项目
            </button>
          </div>
        </div>
      </article>
    </div>
  </main>
</template>
