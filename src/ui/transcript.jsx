import { Diff, Markdown, Spinner } from '@trendr/core'
import { accent, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, RED } from './theme.js'
import { highlight, langForPath } from './highlight.js'

export { defaultTitle as uiTitle } from '../core/tools/recorder.js'

function diffPreviewLines(diff, revert) {
  if (diff?.hunks?.length) return diff.hunks.reduce((sum, h) => sum + h.lines.length, 0)
  // events recorded before created-file writes carried hunks: size from the content itself
  return Math.max(String(revert?.after || '').split('\n').length, String(revert?.before || '').split('\n').length, 2)
}

function ToolCard({ name, title, status, diff, revert, fullOutput, error, background, verbose }) {
  const running = status === 'running'
  const interrupted = status === 'interrupted'
  const reverted = status === 'reverted'
  const failed = status === 'error'
  const outLines = fullOutput ? fullOutput.split('\n') : null

  const info = running ? 'running'
    : interrupted ? 'interrupted'
    : reverted ? 'reverted'
    : failed ? 'failed'
    : background ? 'background · /shells'
    : diff ? `+${diff.additions} -${diff.deletions}`
    : outLines ? `${outLines.length} ${outLines.length === 1 ? 'line' : 'lines'} · ctrl+o`
    : 'done'

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

export function Banner({ version }) {
  return (
    <box style={{ flexDirection: 'row', paddingX: 0, marginTop: 1 }}>
      <box style={{ flexDirection: 'column' }}>
        <text style={{ bold: true, color: accent() }}>{'  pico'}</text>
        <text style={{ color: FAINT }}>{`  v${version}`}</text>
      </box>
    </box>
  )
}

export function Message({ item, verbose }) {
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
      <Markdown text={text} highlight={highlight} codeBg={null} />
    </box>
  )
}
