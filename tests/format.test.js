import { describe, it, expect } from 'vitest'
import { formatText } from '../src/format.js'

describe('formatText XSS 防护', () => {
  it('HTML 标签被转义，不产生可执行元素', () => {
    const out = formatText('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  it('script 标签被转义', () => {
    expect(formatText('<script>alert(1)</script>')).not.toContain('<script')
  })

  it('链接 URL 含引号/空格时不生成 <a>（防属性注入）', () => {
    const out = formatText('[x](https://a.com" onmouseover="alert(1))')
    expect(out).not.toContain('<a ')
  })

  it('javascript: 协议不生成链接', () => {
    expect(formatText('[x](javascript:alert(1))')).not.toContain('<a ')
  })

  it('正常 http(s) 链接生成 <a> 且带 rel=noopener', () => {
    expect(formatText('[官网](https://x.com)')).toBe(
      '<a href="https://x.com" class="md-link" rel="noopener">官网</a>',
    )
  })
})

describe('formatText 渲染规则', () => {
  it('代码块内容不被行内规则改写，保留换行', () => {
    const out = formatText('```\n<b> **bold** </b>\n```')
    expect(out).toBe('<pre><code>\n&lt;b&gt; **bold** &lt;/b&gt;\n</code></pre>')
  })

  it('行内代码内的加粗/链接标记不被二次渲染', () => {
    const out = formatText('前 `**a** [x](https://b.com)` 后')
    expect(out).toContain('<code>**a** [x](https://b.com)</code>')
    expect(out).not.toContain('<strong>')
    expect(out).not.toContain('<a ')
  })

  it('加粗、标题、换行', () => {
    expect(formatText('**粗**')).toBe('<strong>粗</strong>')
    expect(formatText('# 一级')).toContain('<h1>一级</h1>')
    expect(formatText('## 二级')).toContain('<h2>二级</h2>')
    expect(formatText('### 三级')).toContain('<h3>三级</h3>')
    expect(formatText('a\nb')).toContain('a<br>b')
  })

  it('无序/有序列表', () => {
    expect(formatText('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(formatText('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })

  it('空输入返回空串', () => {
    expect(formatText('')).toBe('')
    expect(formatText(null)).toBe('')
  })
})
