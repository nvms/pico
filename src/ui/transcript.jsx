import { Diff, ease, HorizontalScrollBox, linear, Markdown, Spinner, useAnimated } from '@trendr/core'
import { accent, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, RED } from './theme.js'
import { highlight, langForPath } from './highlight.js'

export { defaultTitle as uiTitle } from '../core/tools/recorder.js'

function MarkdownSnippet({ value, language, highlight: highlightCode, codeBg }) {
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
  const Component = language === 'md' || language === 'markdown' ? MarkdownSnippet : CodeSnippet
  return <Component {...props} />
}

function diffPreviewLines(diff, revert) {
  if (diff?.hunks?.length) return diff.hunks.reduce((sum, h) => sum + h.lines.length, 0)
  // events recorded before created-file writes carried hunks: size from the content itself
  return Math.max(String(revert?.after || '').split('\n').length, String(revert?.before || '').split('\n').length, 2)
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

function ToolGroup({ item, verbose }) {
  const latestCallId = item.tools.at(-1)?.callId
  const glow = useAnimated(0, ease(500, linear))
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
        {item.tools.map((tool, i) => <ToolCard key={i} {...tool} verbose showExpandHint={false} />)}
      </box>
    )
  }

  const counts = new Map()
  for (const tool of item.tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
  const entries = [...counts]
  const totalMs = item.tools.reduce((sum, tool) => sum + (tool.durationMs || 0), 0)
  const latestName = item.tools.at(-1)?.name
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
    </box>
  )
}

function ToolCard({ name, title, status, diff, revert, fullOutput, error, background, verbose, showExpandHint = true, startedAt, durationMs }) {
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
    : outLines ? `${outLines.length} ${outLines.length === 1 ? 'line' : 'lines'}${took ? ` · ${took}` : ''}${showExpandHint ? ' · ctrl+o' : ''}`
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
          <text style={{ overflow: 'truncate', color: FG }}>{title || name}</text>
        </box>
        <text style={{ color: FAINT }}>{`  ${info}`}</text>
      </box>
      {failed && error && (
        <text style={{ color: MUTED, overflow: 'truncate' }}>{`  ${error}`}</text>
      )}
      {revert && !running && !reverted && !(diff && diff.additions === 0 && diff.deletions === 0) && (
        <box style={{ flexDirection: 'column', height: Math.min(diffPreviewLines(diff, revert) + 1, 12), marginTop: 1 }}>
          <Diff
            before={revert.before}
            after={revert.after}
            language={langForPath(revert.path)}
            highlight={highlight}
            context={3}
            folds={false}
            focused={false}
            scrollbar={false}
          />
        </box>
      )}
      {outLines && verbose && !running && (
        <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
          <text style={{ color: MUTED }}>{`$ ${title}`}</text>
          {outLines.slice(0, 200).map((line, i) => (
            <text key={i} style={{ color: FG_SOFT, overflow: 'truncate' }}>{line || ' '}</text>
          ))}
          {outLines.length > 200 && <text style={{ color: FAINT }}>{`… ${outLines.length - 200} more lines`}</text>}
        </box>
      )}
    </box>
  )
}

export function Message({ item, verbose }) {
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
    const lines = item.text.split('\n')
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <box style={{ flexDirection: 'row' }}>
          <text style={{ color: MUTED, italic: true }}>{'✦ thoughts'}</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ color: FAINT }}>{`${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · ctrl+o`}</text>
        </box>
        {verbose && (
          <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
            {lines.slice(0, 300).map((line, i) => (
              <text key={i} style={{ color: FG_SOFT, italic: true }}>{line || ' '}</text>
            ))}
            {lines.length > 300 && <text style={{ color: FAINT }}>{`… ${lines.length - 300} more lines`}</text>}
          </box>
        )}
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
    return (
      <box style={{ flexDirection: 'column' }}>
        <text> </text>
        <box style={{ bg: PANEL_BG, flexDirection: 'column', paddingX: 2, paddingY: 1 }}>
          <text style={{ color: FG }}>{item.text}</text>
        </box>
      </box>
    )
  }

  const text = item.interrupted ? `${item.text} *(interrupted)*` : item.text
  return (
    <box style={{ flexDirection: 'column', paddingX: 2 }}>
      <text> </text>
      <Markdown text={text} highlight={highlight} codeBg={null} codeBlock={TranscriptCodeBlock} />
    </box>
  )
}
