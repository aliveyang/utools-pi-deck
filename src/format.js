// 轻量 Markdown → HTML（先转义再生成标签，防 XSS）
// 支持：代码块、行内代码、加粗、标题、有序/无序列表、http(s) 链接
export function formatText(text) {
  if (!text) return ''
  const codeBlocks = []
  let s = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 代码块先抽成占位符，避免内部内容被后续行内规则改写
    .replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code)
      return `\u0000CODE${codeBlocks.length - 1}\u0000`
    })
  // 链接 [text](url)：仅 http/https，URL 内禁止引号以防属性注入
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g,
    (_, t, url) => `<a href="${url}" class="md-link" rel="noopener">${t}</a>`)
  // 无序列表（ul 是块级元素，不需要额外 <br>）
  s = s.replace(/(?:^|\n)((?:[ \t]*[-*+] .*(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*[-*+] /, '').trim()}</li>`).join('')
    return `<ul>${items}</ul>`
  })
  // 有序列表
  s = s.replace(/(?:^|\n)((?:[ \t]*\d+\. .*(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*\d+\. /, '').trim()}</li>`).join('')
    return `<ol>${items}</ol>`
  })
  s = s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\n/g, '<br>')
  // 还原代码块（保留原始换行，不再转 <br>）
  return s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<pre><code>${codeBlocks[+i] || ''}</code></pre>`)
}
