import { icon } from './icons.js'
import { t } from './i18n.js'

// page-shell.ts —— 四个一级页（用量统计 / 通道 / 密钥管理 / 全局配置）共用的控制台页壳。
// 只负责结构：页头（eyebrow + 标题 + 口径 + 操作区）、分组导航、序号分组、12 列槽位网格。
// 不取数、不绑事件；卡片内容仍由各页自己渲染，保证四页的信息架构与视觉语言一致。

// 页头：左侧标题/口径（eyebrow 为空不渲染，口径为空不渲染），右侧操作区（窗口切换、导出等）。无操作时右侧整块不渲染。
export function pageHead(eyebrow, title, desc, actions = '') {
  return `<header class="global-head">
        <div class="global-head-copy">
          ${eyebrow ? `<p class="global-eyebrow">${eyebrow}</p>` : ''}
          <h2 class="global-title">${title}</h2>
          ${desc ? `<p class="global-desc">${desc}</p>` : ''}
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

// 分组导航（tab 分页容器）：仅当页面有 2 个及以上分组时出现；
// 同一时刻只渲染激活分组，长页由此拆成等高的分页（任务看板除外，不经过本壳）。
export function pageNav(items, label, activeId) {
  return `<nav class="global-nav" role="tablist" aria-label="${label}">
        ${items.map(item => `<button type="button" role="tab" class="global-nav-item${item.id === activeId ? ' active' : ''}" data-action="page-tab" data-tab="${item.id}" aria-selected="${item.id === activeId}">${item.label}</button>`).join('')}
      </nav>`
}

// 序号分组：01/02/03 + 标题 + 说明（desc 为空不渲染）+ 12 列槽位网格；headExtra 放分组级操作（如面板顺序切换）。
export function pageSection(section) {
  const { index, id, title, desc = '', body, headExtra = '' } = section
  return `<section class="gsec" id="${id}" aria-labelledby="${id}-title">
        <div class="gsec-head">
          <span class="gsec-index mono">${index}</span>
          <div class="gsec-copy">
            <h3 class="gsec-title" id="${id}-title">${title}</h3>
            ${desc ? `<p class="gsec-desc">${desc}</p>` : ''}
          </div>
          ${headExtra}
        </div>
        <div class="gsec-body">${body}</div>
      </section>`
}

// 页面壳：页头 + 导航 + 分组。sections 为 pageSection 的markup 数组；
// activeTab 非空时只保留该分组（tab 分页），为空时全量渲染。
export function pageShell(head, nav, sections, activeTab = '') {
  const visible = activeTab ? sections.filter(markup => markup.includes(`id="${activeTab}"`)) : sections
  return `<div class="global-page">
      ${head}
      ${nav ?? ''}
      ${visible.join('')}
    </div>`
}

// 槽位：把卡片包进 12 列网格的某一列跨度；卡片自身高度由槽位拉伸对齐。
export function slot(span, body) {
  return `<div class="g-slot g-slot--${span}">${body}</div>`
}
