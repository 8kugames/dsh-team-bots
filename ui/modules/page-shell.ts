import { icon } from './icons.js'
import { t } from './i18n.js'

// page-shell.ts —— 四个一级页（用量统计 / 通道 / 密钥管理 / 全局配置）共用的控制台页壳。
// 只负责结构：页头（eyebrow + 标题 + 口径 + 操作区）、分组导航、序号分组、12 列槽位网格。
// 不取数、不绑事件；卡片内容仍由各页自己渲染，保证四页的信息架构与视觉语言一致。

// 页头：左侧 eyebrow/标题/口径，右侧操作区（窗口切换、导出等）。无操作时右侧整块不渲染。
export function pageHead(eyebrow, title, desc, actions = '') {
  return `<header class="global-head">
        <div class="global-head-copy">
          <p class="global-eyebrow">${eyebrow}</p>
          <h2 class="global-title">${title}</h2>
          <p class="global-desc">${desc}</p>
        </div>
        ${actions ? `<div class="global-head-actions">${actions}</div>` : ''}
      </header>`
}

// 刷新按钮：全局四页并入页头操作区（global-head-actions），其余视图仍由 topbar-actions 摆放。
// 只产结构；点击走 app 壳的 data-action 委托，与页壳「不绑事件」口径一致。
export function refreshAction() {
  const label = t('topbar.refresh')
  return `<button class="btn icon" data-action="refresh" title="${label}" aria-label="${label}">${icon('refresh')}</button>`
}

// 分组导航：仅当页面有 2 个及以上分组时出现，锚点命中高亮由 CSS :target 负责。
export function pageNav(items, label) {
  return `<nav class="global-nav" aria-label="${label}">
        ${items.map(item => `<a class="global-nav-item" href="#${item.id}">${item.label}</a>`).join('')}
      </nav>`
}

// 序号分组：01/02/03 + 标题 + 说明 + 12 列槽位网格；headExtra 放分组级操作（如面板顺序切换）。
export function pageSection(section) {
  const { index, id, title, desc, body, headExtra = '' } = section
  return `<section class="gsec" id="${id}" aria-labelledby="${id}-title">
        <div class="gsec-head">
          <span class="gsec-index mono">${index}</span>
          <div class="gsec-copy">
            <h3 class="gsec-title" id="${id}-title">${title}</h3>
            <p class="gsec-desc">${desc}</p>
          </div>
          ${headExtra}
        </div>
        <div class="gsec-body">${body}</div>
      </section>`
}

// 页面壳：页头 + 导航 + 分组。sections 为 pageSection 的markup 数组。
export function pageShell(head, nav, sections) {
  return `<div class="global-page">
      ${head}
      ${nav ?? ''}
      ${sections.join('')}
    </div>`
}

// 槽位：把卡片包进 12 列网格的某一列跨度；卡片自身高度由槽位拉伸对齐。
export function slot(span, body) {
  return `<div class="g-slot g-slot--${span}">${body}</div>`
}
