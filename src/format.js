// 轻量 Markdown → HTML（先转义再生成标签，防 XSS）
// 支持：代码块（剥离语言名并带显式复制按钮）、行内代码、加粗、标题、有序/无序列表、http(s) 链接
export function formatText(text) {
  if (!text) return ''
  const codeBlocks = []
  let s = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 代码块先抽成占位符，避免内部内容被后续行内规则改写；若有围栏语言名行则剥离
    .replace(/```(?:[^\n`]*\r?\n)?([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code)
      return `\u0000CODE${codeBlocks.length - 1}\u0000`
    })
  // 行内代码同样抽占位符：否则内部的 **、[链接](url) 等会被后续规则二次渲染
  const inlineCodes = []
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code)
    return `\u0001IC${inlineCodes.length - 1}\u0001`
  })
  // 链接 [text](url)：仅 http/https，URL 内禁止引号以防属性注入
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g,
    (_, t, url) => `<a href="${url}" class="md-link" rel="noopener">${t}</a>`)
  // 无序列表（保留末尾换行边界，避免吞掉紧邻其后的标题行首）
  s = s.replace(/(?:^|\n)((?:[ \t]*[-*+] .*(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*[-*+] /, '').trim()}</li>`).join('')
    return `<ul>${items}</ul>${block.endsWith('\n') ? '\n' : ''}`
  })
  // 有序列表
  s = s.replace(/(?:^|\n)((?:[ \t]*\d+\. .*(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*\d+\. /, '').trim()}</li>`).join('')
    return `<ol>${items}</ol>${block.endsWith('\n') ? '\n' : ''}`
  })
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\n/g, '<br>')
  // 还原代码块（带显式复制按钮，保留原始换行）与行内代码
  s = s
    .replace(/\u0000CODE(\d+)\u0000/g, (_, i) =>
      `<div class="code-block"><button type="button" class="code-copy-btn" data-copy-code="1">复制</button><pre><code>${codeBlocks[+i] || ''}</code></pre></div>`)
    .replace(/\u0001IC(\d+)\u0001/g, (_, i) => `<code>${inlineCodes[+i] || ''}</code>`)
  // 清理块级元素紧邻的多余 <br>
  return s
    .replace(/(<\/(?:h[1-3]|ul|ol|pre|div)>)<br>/g, '$1')
    .replace(/<br>(<(?:h[1-3]|ul|ol|pre)|<div class="code-block">)/g, '$1')
}
