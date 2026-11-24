<script setup>
import Icon from './Icon.vue'
import { PI_INSTALL_CMD } from '../constants.js'

defineProps({
  piStatus: { type: Object, default: null },
  envInfo: { type: Object, default: null },
  showEnvHelp: { type: Boolean, default: false },
  needsConfig: { type: Boolean, default: false },
})
const emit = defineEmits(['toggleHelp', 'recheck', 'openLink', 'copyCmd', 'openPath', 'config', 'installPi'])
</script>

<template>
  <div v-if="(piStatus && !piStatus.ok) || needsConfig" class="env-banner">
    <div class="env-banner-head">
      <span class="env-dot" :class="piStatus && !piStatus.ok ? 'err' : 'warn'"></span>
      <strong>{{ piStatus && !piStatus.ok ? 'Pi 环境未就绪' : '模型还没配好' }}</strong>
      <span class="env-sub">
        {{ piStatus && !piStatus.ok
          ? (envInfo && envInfo.errorCode === 'NODE_MISSING' ? '缺少 Node.js ≥ 22.19' : envInfo && envInfo.errorCode === 'PI_MISSING' ? '未检测到 pi CLI' : '无法启动 Pi')
          : '已完成安装，但缺少可用的模型凭证，配置后才能对话' }}
      </span>
      <span class="spacer"></span>
      <template v-if="piStatus && !piStatus.ok">
        <button class="mini-btn" @click="emit('toggleHelp')">{{ showEnvHelp ? '收起' : '安装引导' }}</button>
        <button class="mini-btn" @click="emit('config')">手动指定路径</button>
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
          <button v-if="envInfo && envInfo.nodePath" class="mini-btn env-config-btn" @click="emit('installPi')">
            <Icon name="terminal" :size="12" />终端一键安装
          </button>
          <code class="cmd">{{ PI_INSTALL_CMD }}</code>
          <button class="mini-btn" @click="emit('copyCmd', PI_INSTALL_CMD)">复制</button>
          <span v-if="envInfo && envInfo.piVersion" class="env-ok">已安装 v{{ envInfo.piVersion }}</span>
          <span v-else class="env-miss">未检测到</span>
        </div>
      </div>
      <div class="env-step" :class="{ done: envInfo && envInfo.configs && envInfo.configs.find(c => c.name === 'auth.json' && c.exists) }">
        <div class="env-step-title">3. 配置模型与 API 凭证</div>
        <div class="env-step-body">
          安装完成后点「去配置」即可图形化填写 API Key；也可打开目录
          <code>{{ (envInfo && envInfo.agentDir) || '~/.pi/agent' }}</code>
          <button class="mini-btn" @click="emit('openPath', envInfo && envInfo.agentDir)"><Icon name="folder" :size="12" />打开目录</button>
        </div>
      </div>
      <div class="env-tip">装好后点「重新检测」。若使用 nvm/fnm/自定义路径，可点上方「手动指定路径」直接选取。</div>
    </div>
  </div>
</template>

<style scoped>
.env-banner {
  flex: none; border-bottom: 1px solid var(--warn-line); background: var(--warn-soft);
  padding: 8px 14px; font-size: 12px; color: var(--warn-ink);
}
.env-banner-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.env-banner-head strong { font-size: 11.5px; font-weight: 500; }
.env-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
.env-dot.err { background: var(--danger); }
.env-dot.warn { background: var(--warn-ink); }
.env-config-btn { color: var(--accent); font-weight: 500; }
.env-steps { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.env-step { background: var(--paper); border: 1px solid var(--warn-line); border-radius: var(--r-sm); padding: 8px 10px; }
.env-step.done { border-color: var(--ok-line); background: var(--ok-soft); }
.env-step-title { font-weight: 500; color: var(--ink); margin-bottom: 4px; }
.env-step-body { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--ink-2); }
.env-miss { color: var(--danger); }
.env-ok { color: var(--accent); }
.env-tip { font-size: 11px; }
.cmd { background: var(--surface); border: 1px solid var(--line-2); border-radius: 4px; padding: 1px 5px; font-size: 11px; }
.env-link { color: var(--accent); text-decoration: underline; display: inline-flex; align-items: center; gap: 3px; }
</style>
