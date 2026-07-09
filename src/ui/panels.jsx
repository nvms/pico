import { createSignal, Menu, PickList, ScrollBox, TextInput, useInput } from '@trendr/core'
import { accent, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, SELECT_BG, RED } from './theme.js'
import { fuzzyScore } from './fuzzy.js'

export function timeAgo(at) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function PanelFrame({ title, hint, right, children }) {
  return (
    <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <text style={{ color: accent(), bold: true }}>{title}</text>
        <box style={{ flexGrow: 1 }} />
        {right}
      </box>
      <text style={{ color: MUTED }}>{hint}</text>
      {children}
    </box>
  )
}

export function ScopeTabs({ scopes, active }) {
  return (
    <box style={{ flexDirection: 'row' }}>
      {scopes.map((s, i) => (
        <text key={s} style={{ color: i === active ? accent() : FAINT, bold: i === active }}>{`${i > 0 ? '  ' : ''}${s}`}</text>
      ))}
    </box>
  )
}

export function ModelPanel({ models, current, defaultName, focused, onPick, onPickDefault, onClose }) {
  const [cursor, setCursor] = createSignal(models[0] || null)

  useInput((event) => {
    if (!focused) return
    if (event.ctrl && event.key === 's' && cursor()) {
      onPickDefault(cursor())
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame title="Select model" hint="type to filter · ↑↓ to move · enter for this session · ctrl+s to make it the default · esc to keep current">
      <box style={{ flexDirection: 'column', height: 12, marginTop: 1 }}>
        <PickList
          items={models}
          focused={focused}
          placeholder="filter models..."
          filter={(q, m) => fuzzyScore(q, m.name) >= 0}
          onCursorChange={setCursor}
          onSubmit={onPick}
          onCancel={onClose}
          scrollbar
          gap={1}
          itemHeight={2}
          scrolloff={1}
          renderItem={(m, { selected, focused: f }) => {
            const off = m.available === false
            return (
              <box style={{ flexDirection: 'column', bg: selected ? (f ? accent() : SELECT_BG) : null, paddingX: 1 }}>
                <box style={{ flexDirection: 'row' }}>
                  <text style={{ bold: !off, color: selected ? 'black' : off ? MUTED : FG }}>{m.name}</text>
                  {m.name === current && <text style={{ color: selected ? 'black' : accent() }}>{' ✓'}</text>}
                  {m.name === defaultName && <text style={{ color: selected ? 'black' : MUTED }}>{' · default'}</text>}
                  <box style={{ flexGrow: 1 }} />
                  <text style={{ color: selected ? 'black' : MUTED }}>
                    {off ? `needs ${m.keyHint}` : m.price ? `$${m.price.in} in · $${m.price.out} out` : 'price unknown'}
                  </text>
                </box>
                <text style={{ color: selected ? 'black' : MUTED }}>{m.desc}</text>
              </box>
            )
          }}
        />
      </box>
    </PanelFrame>
  )
}

export function HistoryPanel({ prompts, scopes, scopeIndex, focused, onPick, onClose }) {
  const [preview, setPreview] = createSignal(prompts[0] || null)
  const [query, setQuery] = createSignal('')
  const anyMatch = prompts.some((p) => fuzzyScore(query(), p.text) >= 0)

  return (
    <PanelFrame
      title="Search prompts"
      hint="type to filter · ↑↓ to move · ctrl+s scope · enter to edit · esc to close"
      right={<ScopeTabs scopes={scopes} active={scopeIndex} />}
    >
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          <PickList
            items={prompts}
            focused={focused}
            placeholder="filter prompts..."
            filter={(q, p) => fuzzyScore(q, p.text) >= 0}
            onChange={setQuery}
            onCursorChange={(p) => setPreview(p)}
            onSubmit={(p) => onPick(p.text)}
            onCancel={onClose}
            scrollbar
            gap={1}
            renderItem={(p, { selected, focused: f }) => (
              <box style={{ flexDirection: 'row', bg: selected ? (f ? accent() : SELECT_BG) : null, paddingX: 1 }}>
                <box style={{ flexGrow: 1, height: 1 }}>
                  <text style={{ overflow: 'truncate', color: selected ? 'black' : FG }}>{p.text.replace(/\n/g, ' ')}</text>
                </box>
                <text style={{ color: selected ? 'black' : FAINT, dim: !selected }}>{`  ${timeAgo(p.at)}`}</text>
              </box>
            )}
          />
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          {anyMatch && preview() ? (
            <text style={{ color: FG }}>{preview().text.slice(0, 2000)}</text>
          ) : (
            <text style={{ color: FAINT }}>no matching prompts</text>
          )}
        </box>
      </box>
    </PanelFrame>
  )
}

export function RewindPickPanel({ entries, stats, focused, onPick, onClose }) {
  const [preview, setPreview] = createSignal(entries[0] || null)

  return (
    <PanelFrame title="Rewind to a message" hint="type to filter · ↑↓ to move · enter to choose · esc to close">
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          <PickList
            items={entries}
            focused={focused}
            placeholder="filter messages..."
            filter={(q, m) => fuzzyScore(q, m.text) >= 0}
            onCursorChange={(m) => setPreview(m)}
            onSubmit={onPick}
            onCancel={onClose}
            scrollbar
            gap={1}
            renderItem={(m, { selected, focused: f }) => (
              <box style={{ flexDirection: 'row', bg: selected ? (f ? accent() : SELECT_BG) : null, paddingX: 1 }}>
                <box style={{ flexGrow: 1, height: 1 }}>
                  <text style={{ overflow: 'truncate', color: selected ? 'black' : FG }}>{m.text.replace(/\n/g, ' ')}</text>
                </box>
                <text style={{ color: selected ? 'black' : FAINT, dim: !selected }}>{`  ${stats(m.index).msgs} after`}</text>
              </box>
            )}
          />
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          {preview() ? (
            <box style={{ flexDirection: 'column' }}>
              <text style={{ color: FG }}>{preview().text.slice(0, 2000)}</text>
              <text> </text>
              <text style={{ color: FAINT }}>{`rewinding here drops ${stats(preview().index).msgs} entries`}</text>
              {stats(preview().index).edits.map((m, i) => (
                <text key={i} style={{ color: FAINT }}>{`  ↩ ${m.title}`}</text>
              ))}
            </box>
          ) : (
            <text style={{ color: FAINT }}>no matching messages</text>
          )}
        </box>
      </box>
    </PanelFrame>
  )
}

export function RewindActionPanel({ target, options, focused, onSubmit, onBack }) {
  return (
    <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
      <text style={{ color: accent(), bold: true }}>Rewind options</text>
      <box style={{ flexDirection: 'row' }}>
        <text style={{ color: MUTED }}>{'to: '}</text>
        <box style={{ flexGrow: 1, height: 1 }}>
          <text style={{ overflow: 'truncate', color: FG_SOFT }}>{target.text.replace(/\n/g, ' ')}</text>
        </box>
      </box>
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <Menu
          items={options}
          focused={focused}
          maxVisible={4}
          itemHeight={2}
          gap={1}
          vimKeys
          onSubmit={onSubmit}
          onCancel={onBack}
          renderItem={(o, { active }) => (
            <box style={{ flexDirection: 'column' }}>
              <box style={{ flexDirection: 'row' }}>
                <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                <text style={{ color: active ? accent() : FG }}>{o.label}</text>
              </box>
              <text style={{ color: FAINT }}>{`  ${o.desc}`}</text>
            </box>
          )}
        />
      </box>
      <text style={{ color: FAINT }}>enter to confirm · esc to pick a different message</text>
    </box>
  )
}

function useEscape(focused, onClose) {
  useInput((event) => {
    if (!focused()) return
    if (event.key === 'escape') {
      onClose()
      event.stopPropagation()
    }
  })
}

export function ResumePanel({ sessions, scopes, scopeIndex, loading, focused, onPick, onClose }) {
  const [preview, setPreview] = createSignal(sessions[0] || null)
  useEscape(() => focused, onClose)

  return (
    <PanelFrame
      title="Resume a session"
      hint="type to filter · ↑↓ to move · ctrl+s scope · enter to resume · esc to close"
      right={<ScopeTabs scopes={scopes} active={scopeIndex} />}
    >
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          {loading ? (
            <text style={{ color: MUTED }}>loading sessions...</text>
          ) : sessions.length === 0 ? (
            <text style={{ color: FAINT }}>no sessions here yet</text>
          ) : (
            <PickList
              items={sessions}
              focused={focused && !loading}
              placeholder="filter sessions..."
              filter={(q, s) => fuzzyScore(q, s.title) >= 0}
              onCursorChange={(s) => setPreview(s)}
              onSubmit={onPick}
              onCancel={onClose}
              scrollbar
              gap={1}
              renderItem={(s, { selected, focused: f }) => (
                <box style={{ flexDirection: 'row', bg: selected ? (f ? accent() : SELECT_BG) : null, paddingX: 1 }}>
                  {s.color && <text style={{ color: selected ? 'black' : s.color }}>{'▪ '}</text>}
                  <box style={{ flexGrow: 1, height: 1 }}>
                    <text style={{ overflow: 'truncate', color: selected ? 'black' : FG }}>{s.title.replace(/\n/g, ' ')}</text>
                  </box>
                  <text style={{ color: selected ? 'black' : FAINT, dim: !selected }}>{`  ${timeAgo(s.at)}`}</text>
                </box>
              )}
            />
          )}
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          {preview() ? (
            <box style={{ flexDirection: 'column' }}>
              <text style={{ color: FG }}>{preview().title.slice(0, 500)}</text>
              <text> </text>
              <text style={{ color: FAINT }}>{`${preview().turns} ${preview().turns === 1 ? 'turn' : 'turns'} · ${timeAgo(preview().at)}`}</text>
              <text style={{ color: FAINT, overflow: 'truncate' }}>{preview().header.root}</text>
            </box>
          ) : (
            <text style={{ color: FAINT }}>no sessions</text>
          )}
        </box>
      </box>
    </PanelFrame>
  )
}

export function EffortPanel({ levels, current, defaultLevel, focused, onPick, onPickDefault, onClose }) {
  const [cursor, setCursor] = createSignal(0)
  const items = levels

  useInput((event) => {
    if (!focused) return
    if (event.ctrl && event.key === 's') {
      onPickDefault(items[cursor()])
      event.stopPropagation()
    }
  })

  const label = (l) => (l.key === null ? 'default' : l.key)

  return (
    <PanelFrame title="Thinking effort" hint="j/k or ↑↓ to move · enter for this session · ctrl+s to make it the default · esc to keep current">
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <Menu
          items={items}
          selected={cursor()}
          onSelect={setCursor}
          focused={focused}
          maxVisible={5}
          vimKeys
          onSubmit={onPick}
          onCancel={onClose}
          renderItem={(l, { active }) => (
            <box style={{ flexDirection: 'row' }}>
              <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
              <text style={{ color: active ? accent() : FG }}>{label(l).padEnd(10)}</text>
              <text style={{ color: FAINT }}>{l.desc}</text>
              {l.key === current && <text style={{ color: active ? accent() : MUTED }}>{'  ✓'}</text>}
              {l.key === defaultLevel && <text style={{ color: FAINT }}>{'  · default'}</text>}
            </box>
          )}
        />
      </box>
    </PanelFrame>
  )
}

export function ProjectPanel({ projects, loading, focused, onPick, onClose }) {
  const [preview, setPreview] = createSignal(projects[0] || null)
  useEscape(() => focused, onClose)

  return (
    <PanelFrame title="Switch project" hint="type to filter · ↑↓ to move · enter to jump to its last session · esc to close">
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          {loading ? (
            <text style={{ color: MUTED }}>loading projects...</text>
          ) : projects.length === 0 ? (
            <text style={{ color: FAINT }}>no known projects yet</text>
          ) : (
            <PickList
              items={projects}
              focused={focused && !loading}
              placeholder="filter projects..."
              filter={(q, p) => fuzzyScore(q, p.path) >= 0}
              onCursorChange={(p) => setPreview(p)}
              onSubmit={onPick}
              onCancel={onClose}
              scrollbar
              gap={1}
              renderItem={(p, { selected, focused: f }) => (
                <box style={{ flexDirection: 'row', bg: selected ? (f ? accent() : SELECT_BG) : null, paddingX: 1 }}>
                  {p.latest.color && <text style={{ color: selected ? 'black' : p.latest.color }}>{'▪ '}</text>}
                  <box style={{ flexGrow: 1, height: 1 }}>
                    <text style={{ overflow: 'truncate', color: selected ? 'black' : FG }}>{p.path}</text>
                  </box>
                  <text style={{ color: selected ? 'black' : FAINT, dim: !selected }}>{`  ${p.current ? 'current · ' : ''}${timeAgo(p.latest.at)}`}</text>
                </box>
              )}
            />
          )}
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          {preview() ? (
            <box style={{ flexDirection: 'column' }}>
              <text style={{ color: FG, overflow: 'truncate' }}>{preview().path}</text>
              <text> </text>
              <text style={{ color: FG_SOFT, overflow: 'truncate' }}>{`last: ${preview().latest.title.replace(/\n/g, ' ')}`}</text>
              <text style={{ color: FAINT }}>{`${preview().count} ${preview().count === 1 ? 'session' : 'sessions'} · ${timeAgo(preview().latest.at)}`}</text>
            </box>
          ) : (
            <text style={{ color: FAINT }}>no projects</text>
          )}
        </box>
      </box>
    </PanelFrame>
  )
}

const MCP_STATUS = {
  connected: { icon: '▪', color: accent() },
  connecting: { icon: '◌', color: '#fbbf24' },
  error: { icon: '✗', color: RED },
  disabled: { icon: '▫', color: FAINT },
  idle: { icon: '▫', color: MUTED },
}

export function McpPanel({ servers, focused, onToggle, onReconnect, onRemove, onAdd, onClose }) {
  const [adding, setAdding] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const [viewing, setViewing] = createSignal(null)
  useEscape(() => focused && !adding(), () => (viewing() ? setViewing(null) : onClose()))

  const selected = () => servers[Math.min(index(), servers.length - 1)] || null
  const viewed = () => servers.find((s) => s.name === viewing()) || null

  if (viewing() && viewed()) {
    const server = viewed()
    const describe = (t) => t.description.replace(/^\[[^\]]*\]\s*/, '').trim() || 'no description'
    return (
      <PanelFrame
        title={`MCP servers · ${server.name} · ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`}
        hint="j/k or ↑↓ to scroll · esc back to servers"
      >
        <box style={{ flexDirection: 'column', height: 14, marginTop: 1 }}>
          {server.tools.length === 0 ? (
            <text style={{ color: FAINT }}>no tools reported · is the server connected?</text>
          ) : (
            <ScrollBox style={{ flexGrow: 1 }} focused={focused} scrollbar>
              {server.tools.map((t, i) => (
                <box key={t.name} style={{ flexDirection: 'column', marginTop: i === 0 ? 0 : 1 }}>
                  <text style={{ color: accent() }}>{t.name}</text>
                  <text style={{ color: MUTED }}>{describe(t)}</text>
                </box>
              ))}
            </ScrollBox>
          )}
        </box>
      </PanelFrame>
    )
  }

  return (
    <PanelFrame
      title="MCP servers"
      hint={adding()
        ? 'format: <name> <command...>   e.g. fs npx -y @modelcontextprotocol/server-filesystem /tmp'
        : 'space/enter toggle · t tools · r reconnect · a add · d remove · esc close'}
    >
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        {adding() ? (
          <box style={{ bg: PANEL_BG, flexDirection: 'row', paddingX: 1 }}>
            <text style={{ color: accent() }}>{'+ '}</text>
            <TextInput
              focused={focused}
              placeholder="name command args..."
              clearOnSubmit
              onSubmit={(value) => {
                const trimmed = value.trim()
                const sep = trimmed.indexOf(' ')
                if (sep > 0) {
                  onAdd(trimmed.slice(0, sep), trimmed.slice(sep + 1).trim())
                  setAdding(false)
                }
              }}
              onCancel={() => setAdding(false)}
            />
          </box>
        ) : servers.length === 0 ? (
          <text style={{ color: FAINT }}>no MCP servers configured · press a to add one</text>
        ) : (
          <Menu
            items={servers}
            selected={index()}
            onSelect={setIndex}
            focused={focused}
            maxVisible={6}
            vimKeys
            onSubmit={(s) => onToggle(s.name)}
            onCancel={onClose}
            renderItem={(s, { active }) => {
              const st = MCP_STATUS[s.status] || MCP_STATUS.idle
              return (
                <box style={{ flexDirection: 'row' }}>
                  <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                  <text style={{ color: st.color }}>{st.icon}</text>
                  <text style={{ color: active ? accent() : FG }}>{` ${s.name.padEnd(14)}`}</text>
                  <box style={{ flexGrow: 1, height: 1 }}>
                    <text style={{ overflow: 'truncate', color: s.status === 'error' ? RED : MUTED }}>
                      {s.status === 'error' ? s.error : s.status === 'connected' ? `${s.toolCount} tools` : s.status}
                    </text>
                  </box>
                  <text style={{ color: FAINT, overflow: 'truncate' }}>{`  ${s.command.slice(0, 40)}`}</text>
                </box>
              )
            }}
          />
        )}
      </box>
      {!adding() && (
        <McpKeys
          focused={focused}
          onKey={(key) => {
            const s = selected()
            if (key === 'a') setAdding(true)
            else if (s && key === ' ') onToggle(s.name)
            else if (s && key === 'r') onReconnect(s.name)
            else if (s && key === 'd') onRemove(s.name)
            else if (s && key === 't') setViewing(s.name)
          }}
        />
      )}
    </PanelFrame>
  )
}

function McpKeys({ focused, onKey }) {
  useInput((event) => {
    if (!focused) return
    if ([' ', 'a', 'r', 'd', 't'].includes(event.key)) {
      onKey(event.key)
      event.stopPropagation()
    }
  })
  return null
}
