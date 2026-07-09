import { Diff, Markdown, Spinner } from '@trendr/core'
import { accent, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, RED } from './theme.js'
import { highlight, langForPath } from './highlight.js'

export { defaultTitle as uiTitle } from '../core/tools/recorder.js'

function ToolCard({ name, title, status, diff, revert, fullOutput, error, verbose }) {
  const running = status === 'running'
  const interrupted = status === 'interrupted'
  const reverted = status === 'reverted'
  const failed = status === 'error'
  const outLines = fullOutput ? fullOutput.split('\n') : null

  const info = running ? 'running'
    : interrupted ? 'interrupted'
    : reverted ? 'reverted'
    : failed ? 'failed'
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
        <box style={{ flexDirection: 'column', height: Math.min((diff?.hunks || []).reduce((a, h) => a + h.lines.length, 2) + 1, 12), marginTop: 1 }}>
          <Diff
            before={revert.before}
            after={revert.after}
            language={langForPath(revert.path)}
            highlight={highlight}
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

export function Banner({ version, cwd, modelName }) {
  return (
    <box style={{ flexDirection: 'row', paddingX: 2, marginTop: 1 }}>
      <box style={{ flexDirection: 'column' }}>
        <text style={{ color: accent() }}>{'(\\_/)'}</text>
        <text style={{ color: accent() }}>{'(•ᴗ•)'}</text>
      </box>
      <box style={{ flexDirection: 'column' }}>
        <box style={{ flexDirection: 'row' }}>
          <text style={{ bold: true, color: accent() }}>{'  pico'}</text>
          <text style={{ color: FAINT }}>{` v${version} · ${modelName}`}</text>
        </box>
        <text style={{ color: MUTED }}>{`  ${cwd}`}</text>
      </box>
    </box>
  )
}

export function Message({ item, verbose }) {
  if (item.kind === 'tool') {
    return <ToolCard {...item} verbose={verbose} />
  }

  if (item.kind === 'summary') {
    return (
      <box style={{ flexDirection: 'column', paddingX: 2 }}>
        <text> </text>
        <text style={{ color: MUTED, italic: true }}>{`✦ summary: ${item.text.replace(/\n/g, ' ').slice(0, 500)}`}</text>
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
          <text style={{ color: '#f9fafb' }}>{item.text}</text>
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
