export function transcriptToMarkdown(transcript, { title = 'pico session' } = {}) {
  const parts = [`# ${title}`, '']
  for (const item of transcript) {
    if (item.kind === 'user') {
      parts.push('## You', '', item.text, '')
    } else if (item.kind === 'assistant') {
      parts.push(item.interrupted ? `${item.text}\n\n*(interrupted)*` : item.text, '')
    } else if (item.kind === 'tool') {
      const label = item.diff ? ` (+${item.diff.additions} -${item.diff.deletions})` : ''
      parts.push(`> ${item.status === 'reverted' ? '↩' : '✓'} \`${item.name}\` ${item.title}${label}`, '')
    } else if (item.kind === 'summary') {
      parts.push(`> summary: ${item.text}`, '')
    }
  }
  return parts.join('\n')
}
