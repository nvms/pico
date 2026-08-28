import { Diff, ease, HorizontalScrollBox, linear, Markdown, Spinner, useAnimated } from '@trendr/core'
import { accent, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, SELECT_BG, RED, GREEN } from './theme.js'
import { highlight, langForPath } from './highlight.js'

export { defaultTitle as uiTitle } from 'picocode-core/tools/recorder.js'

function ProseSnippet({ value, language, highlight: highlightCode, codeBg }) {
  const shown = highlightCode ? highlightCode(value, language) : value
  return (
    <box style={{ bg: codeBg, paddingX: 1 }}>
      <text>{shown}</text>
    </box>
  )
}

function CodeSnippet({ value, language, highlight: highlightCode, codeBg }) {
  const shown = highlightCode ? highlightCode(value, language) : value
  const contentWidth = Math.max(0, ...value.split('\n').map((line) => [...line].length)) + 2
  return (
    <HorizontalScrollBox contentWidth={contentWidth} style={{ bg: codeBg, paddingX: 1 }}>
      <box style={{ flexDirection: 'column' }}>
        {shown.split('\n').map((line, key) => (
          <text key={key} style={{ overflow: 'nowrap' }}>{line || ' '}</text>
        ))}
      </box>
    </HorizontalScrollBox>
  )
}

function TranscriptCodeBlock(props) {
  const language = props.language?.toLowerCase()
  const Component = ['md', 'markdown', 'text', 'txt', 'plaintext'].includes(language) ? ProseSnippet : CodeSnippet
  return <Component {...props} />
}

function diffPreview(diff, revert) {
  if (!diff?.hunks?.length) return { before: String(revert?.before || ''), after: String(revert?.after || '') }
  const before = []
  const after = []
  diff.hunks.forEach((hunk, index) => {
    if (index) {
      before.push('⋯')
      after.push('⋯')
    }
    for (const line of hunk.lines) {
      if (line.type !== 'add') before.push(line.text)
      if (line.type !== 'remove') after.push(line.text)
    }
  })
  return { before: before.join('\n'), after: after.join('\n') }
}

function diffPreviewLines(diff, revert) {
  if (diff?.hunks?.length) return diff.hunks.reduce((sum, h) => sum + h.lines.length, 0)
  const preview = diffPreview(diff, revert)
  return Math.max(preview.after.split('\n').length, preview.before.split('\n').length, 2)
}

function fmtDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  const secs = Math.round(ms / 1000)
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function fmtRunning(ms) {
  const secs = Math.floor(ms / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function mixColor(from, to, amount) {
  const rgb = (color) => color?.startsWith('#') && color.length === 7
    ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    : [127, 127, 127]
  const a = rgb(from)
  const b = rgb(to)
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * amount).toString(16).padStart(2, '0')).join('')}`
}

const TOOL_DESCRIPTION_LIMIT = 5
const BASH_OUTPUT_LINES = 10
const TOOL_NAME_FLASH_MS = 900
const DESCRIPTION_REVEAL_DELAY_MS = 500
const DESCRIPTION_REVEAL_MS = 700

function delayedLinear(t) {
  const delay = DESCRIPTION_REVEAL_DELAY_MS / (DESCRIPTION_REVEAL_DELAY_MS + DESCRIPTION_REVEAL_MS)
  return t <= delay ? 0 : (t - delay) / (1 - delay)
}

function DescriptionReveal({ children, running }) {
  const reveal = useAnimated(running ? 0 : 1, ease(DESCRIPTION_REVEAL_DELAY_MS + DESCRIPTION_REVEAL_MS, delayedLinear))
  if (!running) reveal.set(1)
  return <text style={{ color: mixColor(accent(), FG, reveal()) }}>{children}</text>
}

function outputLines(value) {
  if (!value) return []
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function BashOutput({ value, lineStart, lineCount }) {
  const lines = outputLines(value)
  if (!lines.length) return null
  const shown = lines.slice(-BASH_OUTPUT_LINES)
  const first = lineStart || (lineCount ? lineCount - shown.length + 1 : lines.length - shown.length + 1)
  const last = lineCount || first + shown.length - 1
  const gutterWidth = String(last).length
  return (
    <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
      {shown.map((line, i) => (
        <box key={first + i} style={{ flexDirection: 'row' }}>
          <text style={{ color: FAINT }}>{`${String(first + i).padStart(gutterWidth)} `}</text>
          <text style={{ color: FG_SOFT, overflow: 'truncate' }}>{line || ' '}</text>
        </box>
      ))}
    </box>
  )
}

function CompactToolSign({ tool }) {
  if (tool.name !== 'bash') return <text>{'  '}</text>
  if (tool.background) return <text style={{ color: accent() }}>{'↪ '}</text>
  if (tool.status === 'running') return <box style={{ width: 2 }}><Spinner color={accent()} /></box>
  if (tool.exitCode === 0) return <text style={{ color: GREEN }}>{'✓ '}</text>
  if (tool.exitCode != null) return <text style={{ color: RED }}>{'× '}</text>
  return <text>{'  '}</text>
}

function ToolGroup({ item, verbose }) {
  const latestCallId = item.tools.at(-1)?.callId
  const glow = useAnimated(0, ease(TOOL_NAME_FLASH_MS, linear))
  if (latestCallId !== glow._callId) {
    glow._callId = latestCallId
    if (item.active) {
      glow.snap(1)
      glow.set(0)
    }
  }

  if (verbose) {
    return (
      <box style={{ flexDirection: 'column' }}>
        {(item.items || item.tools).map((entry, i) => entry.kind === 'thoughts'
          ? <Message key={i} item={entry} verbose />
          : <ToolCard key={i} {...entry} verbose showExpandHint={false} />)}
      </box>
    )
  }

  const counts = new Map()
  for (const tool of item.tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
  const entries = [...counts]
  const totalMs = item.tools.reduce((sum, tool) => sum + (tool.durationMs || 0), 0)
  const latestName = item.tools.at(-1)?.name
  const activity = (item.items || item.tools).map((entry) => entry.kind === 'thoughts'
    ? { ...entry, name: 'thoughts', description: entry.text.replace(/\s+/g, ' ').trim(), thought: true }
    : entry).filter((entry) => entry.description)
  const descriptions = activity.slice(-TOOL_DESCRIPTION_LIMIT).reverse()
  const hiddenDescriptions = activity.length - descriptions.length
  const toolNameWidth = Math.max(0, ...descriptions.map((entry) => entry.name.length))
  const visibleBash = item.active && item.tools.at(-1)?.name === 'bash' ? item.tools.at(-1) : null
  return (
    <box style={{ flexDirection: 'column', paddingX: 2 }}>
      <text> </text>
      <box style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        {item.active ? <Spinner color={accent()} /> : <text style={{ color: MUTED }}>✓</text>}
        <box style={{ flexDirection: 'row', flexWrap: 'wrap', flexGrow: 1, marginRight: 2 }}>
          <text style={{ color: item.active ? FG : MUTED }}> Called </text>
          {entries.map(([name, count], i) => (
            <text key={name} style={{ color: item.active && name === latestName ? mixColor(FG, accent(), glow()) : item.active ? FG : MUTED }}>
              {`${i ? ', ' : ''}${name}${count === 1 ? '' : ` ${count} times`}`}
            </text>
          ))}
        </box>
        {totalMs > 0 && <text style={{ color: FAINT, flexShrink: 0 }}>{fmtDuration(totalMs)}</text>}
      </box>
      <box style={{ flexDirection: 'column', paddingLeft: 2 }}>
        {descriptions.map((tool, i) => (
          <box key={tool.callId || `thought-${i}`} style={{ flexDirection: 'row' }}>
            {tool.thought ? <text>{'  '}</text> : <CompactToolSign tool={tool} />}
            <text style={{ color: MUTED, italic: tool.thought }}>{`${tool.name.padStart(toolNameWidth)}  `}</text>
            {tool.thought
              ? <box style={{ flexGrow: 1, height: 1 }}><text style={{ color: MUTED, italic: true, overflow: 'truncate' }}>{tool.description}</text></box>
              : <DescriptionReveal running={tool.status === 'running'}>{tool.description}</DescriptionReveal>}
          </box>
        ))}
        {hiddenDescriptions > 0 && (
          <box style={{ flexDirection: 'row' }}>
            <text>{' '.repeat(toolNameWidth + 4)}</text>
            <text style={{ color: FAINT }}>{`...${hiddenDescriptions} more`}</text>
          </box>
        )}
        {visibleBash?.fullOutput && <BashOutput value={visibleBash.fullOutput} lineStart={visibleBash.outputLineStart} lineCount={visibleBash.outputLineCount} />}
      </box>
    </box>
  )
}

function ToolCard({ name, title, titleLang, description, status, diff, revert, fullOutput, outputLineStart, outputLineCount, error, background, verbose, showExpandHint = true, startedAt, durationMs }) {
  const shownTitle = name === 'bash' ? null : titleLang && title ? highlight(title, titleLang) : title
  const preview = diffPreview(diff, revert)
  const running = status === 'running'
  const interrupted = status === 'interrupted'
  const reverted = status === 'reverted'
  const failed = status === 'error'
  const outLines = fullOutput ? fullOutput.split('\n') : null

  const elapsed = running && startedAt ? Date.now() - startedAt : 0
  const took = !running && !background && durationMs != null ? fmtDuration(durationMs) : null

  const info = running ? (elapsed >= 5000 ? `running (${fmtRunning(elapsed)})` : 'running')
    : interrupted ? 'interrupted'
    : reverted ? 'reverted'
    : failed ? `failed${took ? ` · ${took}` : ''}`
    : background ? 'background · shell listed below'
    : diff ? `+${diff.additions} -${diff.deletions}${took ? ` · ${took}` : ''}`
    : outLines ? `${outputLineCount || outLines.length} ${(outputLineCount || outLines.length) === 1 ? 'line' : 'lines'}${took ? ` · ${took}` : ''}${showExpandHint ? ' · ctrl+o' : ''}`
    : `done${took ? ` · ${took}` : ''}`

  return (
    <box style={{ flexDirection: 'column', paddingX: 2 }}>
      <text> </text>
      <box style={{ flexDirection: 'row' }}>
        {running
          ? <Spinner color={accent()} />
          : <text style={{ color: interrupted || failed ? RED : reverted ? MUTED : accent() }}>{interrupted ? '✗' : failed ? '✗' : reverted ? '↩' : '✓'}</text>}
        <text> </text>
        <text style={{ color: MUTED }}>{`${name.padEnd(5)} `}</text>
        <box style={{ flexGrow: 1, height: 1 }}>
          <text style={{ overflow: 'truncate', color: FG }}>{shownTitle || (name === 'bash' ? '' : name)}</text>
        </box>
        <text style={{ color: FAINT }}>{`  ${info}`}</text>
      </box>
      {description && (
        <box style={{ paddingLeft: 8 }}>
          <text style={{ color: MUTED }}>{description}</text>
        </box>
      )}
      {verbose && name === 'bash' && title && (
        <box style={{ paddingLeft: 8 }}>
          <text style={{ color: FG }}>{highlight(title, titleLang || 'bash')}</text>
        </box>
      )}
      {failed && error && (
        <text style={{ color: MUTED, overflow: 'truncate' }}>{`  ${error}`}</text>
      )}
      {revert && !running && !reverted && !(diff && diff.additions === 0 && diff.deletions === 0) && (
        <box style={{ flexDirection: 'column', height: diffPreviewLines(diff, revert), marginTop: 1, paddingLeft: 8 }}>
          <Diff
            before={preview.before}
            after={preview.after}
            language={langForPath(revert.path)}
            highlight={highlight}
            context={3}
            folds={false}
            focused={false}
            scrollbar={false}
          />
        </box>
      )}
      {name === 'bash' && fullOutput && <box style={{ paddingLeft: 8 }}><BashOutput value={fullOutput} lineStart={outputLineStart} lineCount={outputLineCount} /></box>}
      {outLines && verbose && name !== 'bash' && !running && (
        <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
          {outLines.slice(0, 200).map((line, i) => (
            <text key={i} style={{ color: FG_SOFT, overflow: 'truncate' }}>{line || ' '}</text>
          ))}
          {outLines.length > 200 && <text style={{ color: FAINT }}>{`… ${outLines.length - 200} more lines`}</text>}
        </box>
      )}
    </box>
  )
}

export function Message({ item, verbose, showLocked = false }) {
  if (item.kind === 'tool-group') return <ToolGroup item={item} verbose={verbose} />

  if (item.kind === 'agent-notice-group') {
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <box style={{ flexDirection: 'row' }}>
          <text style={{ color: MUTED, italic: true }}>{`⚙ ${item.notices.length} agents finished`}</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ color: FAINT }}>{'ctrl+o'}</text>
        </box>
        {verbose && (
          <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
            {item.notices.map((notice, i) => (
              <text key={i} style={{ color: FG_SOFT }}>{notice.text.replace(/^\[system notification\]\s*/, '')}</text>
            ))}
          </box>
        )}
      </box>
    )
  }

  if (item.kind === 'tool') {
    return <ToolCard {...item} verbose={verbose} />
  }

  if (item.kind === 'summary') {
    const lines = item.text.split('\n')
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <box style={{ flexDirection: 'row' }}>
          <text style={{ color: MUTED, italic: true }}>{item.source === 'compact' ? '✦ summary · conversation compacted above this point' : '✦ summary · rewound conversation'}</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ color: FAINT }}>{`${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · ctrl+o`}</text>
        </box>
        {verbose && (
          <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
            {lines.slice(0, 500).map((line, i) => (
              <text key={i} style={{ color: FG_SOFT }}>{line || ' '}</text>
            ))}
            {lines.length > 500 && <text style={{ color: FAINT }}>{`… ${lines.length - 500} more lines`}</text>}
          </box>
        )}
      </box>
    )
  }

  if (item.kind === 'thoughts') {
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <box style={{ paddingX: 1 }}>
          <text style={{ color: MUTED, italic: true }}>{item.text}</text>
        </box>
      </box>
    )
  }

  if (item.kind === 'deliberation-turn') {
    const proposer = item.role === 'proposer'
    const synthesis = item.role === 'synthesis'
    const label = synthesis ? 'Synthesis' : `${proposer ? 'Proposer' : 'Reviewer'} · round ${item.round}`
    const text = item.interrupted ? `${item.text} *(interrupted)*` : item.text
    return (
      <box style={{ flexDirection: 'column', marginTop: 1, paddingX: 2 }}>
        <box style={{ flexDirection: 'row' }}>
          <box style={{ width: 1, flexShrink: 0, bg: synthesis || proposer ? accent() : MUTED }} />
          <box style={{ flexDirection: 'column', flexGrow: 1, paddingX: 2, paddingY: 1, bg: synthesis ? SELECT_BG : proposer ? PANEL_BG : undefined }}>
            <text style={{ color: synthesis || proposer ? accent() : MUTED, bold: true }}>{label}</text>
            <Markdown
              text={text}
              highlight={highlight}
              codeBg={null}
              codeBlock={TranscriptCodeBlock}
              tableBorderColor={MUTED}
              tableRowHoverBg={PANEL_BG}
            />
          </box>
        </box>
      </box>
    )
  }

  if (item.kind === 'notice') {
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <text style={{ color: MUTED, italic: true }}>{`⚙ ${item.text.replace(/^\[system notification\]\s*/, '')}`}</text>
      </box>
    )
  }

  if (item.kind === 'skill') {
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <text style={{ color: MUTED, italic: true }}>{`✦ skill: ${item.name}`}</text>
      </box>
    )
  }

  if (item.kind === 'steer-tools') {
    return (
      <box style={{ paddingX: 2, paddingY: 1 }}>
        <text style={{ color: MUTED, italic: true }}>{`── ${item.count} tool ${item.count === 1 ? 'interaction' : 'interactions'} hidden ──`}</text>
      </box>
    )
  }

  if (item.kind === 'shell-command') {
    const shown = highlight(item.text, 'bash')
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <text style={{ color: MUTED, bold: true }}>{'command'}</text>
        <box style={{ flexDirection: 'column', paddingLeft: 2 }}>
          {shown.split('\n').map((line, i) => <text key={i}>{`${i === 0 ? '$ ' : '  '}${line || ' '}`}</text>)}
        </box>
      </box>
    )
  }

  if (item.kind === 'shell-output') {
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <text style={{ color: MUTED, bold: true }}>{'output'}</text>
        <box style={{ flexDirection: 'column', paddingLeft: 2 }}>
          {item.text.split('\n').map((line, i) => <text key={i} style={{ color: FG_SOFT }}>{line || ' '}</text>)}
        </box>
      </box>
    )
  }

  if (item.kind === 'user') {
    const label = showLocked && item.locked ? 'Locked · compacted' : showLocked ? 'User' : null
    return (
      <box style={{ flexDirection: 'column' }}>
        <text> </text>
        <box style={{ flexDirection: 'row' }}>
          <box style={{ width: 1, flexShrink: 0, bg: item.steerSelected ? accent() : PANEL_BG }} />
          <box style={{ bg: item.steerSelected ? SELECT_BG : PANEL_BG, flexDirection: 'column', flexGrow: 1, paddingLeft: 1, paddingRight: 2, paddingY: 1 }}>
            {label && <text style={{ color: item.steerSelected ? accent() : MUTED, bold: true }}>{label}</text>}
            <text style={{ color: FG }}>{item.text}</text>
          </box>
        </box>
      </box>
    )
  }

  const text = item.interrupted ? `${item.text} *(interrupted)*` : item.text
  const label = showLocked && item.locked ? 'Locked · compacted' : showLocked ? 'Assistant' : null
  return (
    <box style={{ flexDirection: 'column' }}>
      <text> </text>
      <box style={{ flexDirection: 'row' }}>
        <box style={{ width: 1, flexShrink: 0, bg: item.steerSelected ? accent() : undefined }} />
        <box style={{ flexDirection: 'column', flexGrow: 1, paddingLeft: 1, paddingRight: 2, paddingY: showLocked ? 1 : 0, bg: item.steerSelected ? SELECT_BG : undefined }}>
          {label && <text style={{ color: item.steerSelected ? accent() : MUTED, bold: true }}>{label}</text>}
          <Markdown
            text={text}
            highlight={highlight}
            codeBg={null}
            codeBlock={TranscriptCodeBlock}
            tableBorderColor={MUTED}
            tableRowHoverBg={PANEL_BG}
          />
        </box>
      </box>
    </box>
  )
}
