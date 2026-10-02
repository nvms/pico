import { ScrollBox, useFocus, useLayout, useInterval, createSignal } from '@trendr/core'
import { homedir } from 'node:os'
import { SESSION_COLORS } from 'picocode-core/controller.js'
import { FG_SOFT, MUTED, PANEL_BG, accent } from './theme.js'
import { timeAgo } from './panels.jsx'

function SessionRow({ row, selected, focus, now }) {
  const layout = useLayout()
  focus.item(row.id, layout)
  const color = SESSION_COLORS[row.color] || row.color || accent()
  return <box style={{ flexDirection: 'column', paddingX: 1, height: 2, flexShrink: 0, bg: selected ? color : undefined }}>
    <text style={{ color: selected ? 'black' : color, bold: true, overflow: 'truncate' }}>{`${row.status === 'busy' ? '●' : '○'} ${row.name}`}</text>
    <text style={{ color: selected ? 'black' : FG_SOFT, overflow: 'truncate' }}>{row.status === 'busy' ? row.activity || 'working' : row.lastMessageAt ? `Last message ${timeAgo(row.lastMessageAt)}` : 'idle'}</text>
  </box>
}

export function WorkspaceSidebar({ groups, selected, width, loading, error, onHeight }) {
  const focus = useFocus({ initial: null, active: false })
  const [now, setNow] = createSignal(Date.now())
  useInterval(() => setNow(Date.now()), 10000)
  if (selected) focus.focus(selected)
  const home = homedir()
  return <box style={{ width, flexShrink: 0, height: '100%', flexDirection: 'column', bg: PANEL_BG }}>
    <text style={{ color: FG_SOFT, bold: true, paddingX: 1 }}>Sessions</text>
    {loading && <text style={{ color: MUTED }}>loading</text>}
    {error && <text style={{ color: MUTED, overflow: 'truncate' }}>{error}</text>}
    <ScrollBox style={{ flexGrow: 1 }} followFocus={focus} focusPadding={1} onMetrics={(metrics) => onHeight(metrics.visibleHeight)}>
      {groups.map((group, index) => <box key={group.cwd} style={{ flexDirection: 'column', marginTop: index > 0 ? 1 : 0 }}>
        <text style={{ color: MUTED, overflow: 'truncate', paddingX: 1 }}>{group.cwd === home ? '~' : group.cwd.startsWith(home + '/') ? '~' + group.cwd.slice(home.length) : group.cwd}</text>
        {group.sessions.map((row) => <SessionRow key={row.id} row={row} selected={row.id === selected} focus={focus} now={now()} />)}
      </box>)}
    </ScrollBox>
  </box>
}
