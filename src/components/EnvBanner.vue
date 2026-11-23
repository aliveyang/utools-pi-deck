<script setup>
import Icon from './Icon.vue'

defineProps({
  piStatus: { type: Object, default: null },
  envInfo: { type: Object, default: null },
  showEnvHelp: { type: Boolean, default: false },
  needsConfig: { type: Boolean, default: false },
})
const emit = defineEmits(['toggleHelp', 'recheck', 'openLink', 'copyCmd', 'openPath', 'config'])

const PI_INSTALL_CMD = 'npm i -g @earendil-works/pi-coding-agent'
</script>

<template>
  <div v-if="(piStatus && !piStatus.ok) || needsConfig" class="env-banner">
    <div class="env-banner-head">
      <span class="env-dot" :class="piStatus && !piStatus.ok ? 'err' : 'warn'"></span>
      <strong>{{ piStatus && !piStatus.ok ? 'Pi 环境未就绪' : '模型还没配好' }}</strong>
      <span class="env-sub">
        {{ piStatus && !piStatus.ok
          ? (envInfo && envInfo.errorCode === 'NODE_MISSING' ? '缺少 Node.js' : envInfo && envInfo.errorCode === 'PI_MISSING' ? '未安装 pi CLI' : '无法启动 Pi')
          : '已完成安装，但缺少可用的模型凭证，配置后才能对话' }}
      </span>
      <span class="spacer"></span>
      <template v-if="piStatus && !piStatus.ok">
        <button class="mini-btn" @click="emit('toggleHelp')">{{ showEnvHelp ? '收起' : '如何安装' }}</button>
        <button class="mini-btn" @click="emit('recheck')"><Icon name="refresh" :size="12" />重新检测</button>
      </template>
      <template v-else>
        <button class="mini-btn env-config-btn" @click="emit('config')">去配置</button>
        <button class="mini-btn" @click="emit('recheck')"><Icon name="refresh" :size="12" />重新检测</button>
      </template>
    </div>
    <div v-if="showEnvHelp && (!piStatus || !piStatus.ok)" class="env-steps">
      <div class="env-step" :class="{ done: envInfo && envInfo.nodePath }">
        <div class="env-step-title">1. 安装 Node.js <b>≥ 22.19</b></div>
        <div class="env-step-body">
          下载：<a href="#" class="env-link" @click.prevent="emit('openLink', 'https://nodejs.org')">nodejs.org<Icon name="external" :size="11" /></a>
          <span v-if="envInfo && envInfo.nodeVersion" class="env-ok">已检测 {{ envInfo.nodeVersion }}</span>
          <span v-else class="env-miss">未检测到</span>
        </div>
      </div>
      <div class="env-step" :class="{ done: envInfo && envInfo.piPath }">
        <div class="env-step-title">2. 安装 pi CLI</div>
        <div class="env-step-body">
          <code class="cmd">{{ PI_INSTALL_CMD }}</code>
          <button class="mini-btn" @click="emit('copyCmd', PI_INSTALL_CMD)">复制</button>
          <span v-if="envInfo && envInfo.piVersion" class="env-ok">已安装 v{{ envInfo.piVersion }}</span>
          <span v-else class="env-miss">未检测到</span>
        </div>
      </div>
      <div class="env-step" :class="{ done: envInfo && envInfo.configs && envInfo.configs.find(c => c.name === 'auth.json' && c.exists) }">
        <div class="env-step-title">3. 配置模型与 API 凭证</div>
        <div class="env-step-body">
          运行 <code class="cmd">pi</code> 进入交互界面，按提示登录/配置模型；或编辑
          <code>{{ (envInfo && envInfo.agentDir) || '~/.pi/agent' }}</code>
          <button class="mini-btn" @click="emit('openPath', envInfo && envInfo.agentDir)"><Icon name="folder" :size="12" />打开目录</button>
        </div>
      </div>
      <div class="env-tip">装好后点「重新检测」。若仍失败，重启 uTools 让环境变量生效。</div>
    </div>
  </div>
</template>
