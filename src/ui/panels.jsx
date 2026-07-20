import { createSignal, Button, Checkbox, ease, Field, FieldList, Menu, NumberInput, PickList, Radio, ScrollBox, TextInput, useAnimated, useFocus, useInput, useInterval, useLayout } from '@trendr/core'
import { accent, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, SELECT_BG, RED, GREEN } from './theme.js'
import { AnimatedValue } from './animated-value.jsx'
import { compactNumber } from './format.js'
import { homedir } from 'node:os'
import { fuzzyScore, rankFuzzy } from './fuzzy.js'
import { formatHttpServerSpec, parseServerSpec, redactServerSpec, REDACTED_HEADER } from '../core/mcp.js'

function shortenHome(path) {
  const value = String(path)
  const home = homedir()
  return value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value
}

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
    <box style={{ flexDirection: 'column', bg: PANEL_BG }}>
      <box style={{ flexDirection: 'column', paddingX: 2, paddingTop: 1 }}>
        <box style={{ flexDirection: 'row' }}>
          <text style={{ color: accent(), bold: true }}>{title}</text>
          <box style={{ flexGrow: 1 }} />
          {right}
        </box>
        <text style={{ color: MUTED }}>{hint}</text>
      </box>
      <text style={{ color: SELECT_BG, overflow: 'clip' }}>{'─'.repeat(process.stdout.columns || 80)}</text>
      <box style={{ flexDirection: 'column', paddingX: 2, paddingBottom: 1 }}>
        {children}
      </box>
    </box>
  )
}

export function ConfirmPanel({ title, message, confirmLabel = 'Confirm', focused, onConfirm, onClose }) {
  useInput((event) => {
    if (!focused) return
    if (event.key === 'escape') {
      onClose()
      event.stopPropagation()
    } else if (event.key === 'return') {
      onConfirm()
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame title={title} hint={`enter: ${confirmLabel.toLowerCase()} · esc: cancel`}>
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <text style={{ color: FG }}>{message}</text>
        <text style={{ color: RED, bold: true }}>This cannot be undone.</text>
      </box>
    </PanelFrame>
  )
}

function ConfigField({ field, value, focused, onChange }) {
  return (
    <box style={{ flexDirection: 'column', marginBottom: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <Checkbox checked={value} label={field.label} focused={focused} onChange={onChange} />
        <box style={{ flexGrow: 1 }} />
        <text style={{ color: FAINT }}>{field.path}</text>
      </box>
      <text style={{ color: FAINT }}>{`    ${field.desc}`}</text>
    </box>
  )
}

function ConfigNumberField({ value, focused, onChange }) {
  return (
    <box style={{ flexDirection: 'column', marginBottom: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <NumberInput focused={focused} value={value} onChange={onChange} min={1} max={100} width={5} />
        <text style={{ color: FG }}> Parallel agent limit</text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ color: FAINT }}>research.agentLimit</text>
      </box>
      <text style={{ color: FAINT }}>    Maximum agents per parallel run (1-100)</text>
    </box>
  )
}

function ConfigModelField({ model, focused, onPick }) {
  return (
    <box style={{ flexDirection: 'column', marginBottom: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <Button label="Parallel worker model" focused={focused} onPress={onPick} />
        <box style={{ flexGrow: 1 }} />
        <text style={{ color: FAINT }}>models.researchWorker</text>
      </box>
      <text style={{ color: FAINT }}>{`    ${model || 'Not configured'} · model used by parallel agents`}</text>
    </box>
  )
}

export function ConfigPanel({ values, focused, onChange, onPickResearchModel, onClose }) {
  const fields = [
    { name: 'clouds', label: 'Cloud animation', desc: 'Show animated clouds on the empty screen', path: 'animation.clouds' },
    { name: 'compactTools', label: 'Compact tool history', desc: 'Summarize consecutive tool calls in one row', path: 'display.compactToolHistory' },
    { name: 'gitStatus', label: 'Git in footer', desc: 'Show branch and changed line counts in the footer', path: 'display.gitStatus' },
    { name: 'wideSidebar', label: 'Wide sidebar', desc: 'Move panels and status details to a right sidebar when the terminal is wider than 160 columns', path: 'display.wideSidebar' },
  ]

  useInput((event) => {
    if (!focused) return
    if (event.key === 'escape') {
      onClose()
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame title="Configuration" hint="tab: next setting · space/enter: change · esc: close">
      <box style={{ height: 12, marginTop: 1 }}>
        <FieldList focused={focused} initialFocus="clouds" scrollbar focusPadding={1}>
          {fields.map((field) => (
            <Field key={field.name} name={field.name}>
              {({ focused: fieldFocused }) => (
                <ConfigField field={field} value={values[field.name]} focused={fieldFocused} onChange={(value) => onChange(field.name, value)} />
              )}
            </Field>
          ))}
          <Field name="researchModel">
            {({ focused: fieldFocused }) => <ConfigModelField model={values.researchModel} focused={fieldFocused} onPick={onPickResearchModel} />}
          </Field>
          <Field name="researchAgentLimit">
            {({ focused: fieldFocused }) => <ConfigNumberField value={values.researchAgentLimit} focused={fieldFocused} onChange={(value) => onChange('researchAgentLimit', value)} />}
          </Field>
        </FieldList>
      </box>
    </PanelFrame>
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

export function ModelPanel({ models, current, defaultName, focused, onPick, onPickDefault, onClose, title = 'Select model', hint = 'enter: this session · ctrl+s: set as default · esc: close' }) {
  const [cursor, setCursor] = createSignal(models[0] || null)
  const [query, setQuery] = createSignal('')
  const rankedModels = rankFuzzy(models, query(), (q, model) => fuzzyScore(q, model.name))

  useInput((event) => {
    if (!focused) return
    if (event.ctrl && event.key === 's' && cursor()) {
      onPickDefault(cursor())
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame title={title} hint={hint}>
      <box style={{ flexDirection: 'column', height: 12, marginTop: 1 }}>
        <PickList
          counter
          items={rankedModels}
          focused={focused}
          placeholder="filter models..."
          filter={() => true}
          onChange={setQuery}
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
                    {off ? `needs ${m.keyHint}` : m.price ? `$${m.price.in} in · $${m.price.out} out` : m.provider === 'codex' ? 'subscription' : 'price unknown'}
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
      hint="↑↓ to move · ctrl+s scope · enter to edit · esc to close"
      right={<ScopeTabs scopes={scopes} active={scopeIndex} />}
    >
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          <PickList
            counter
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
    <PanelFrame title="Rewind to a message" hint="↑↓ to move · enter to choose · esc to close">
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          <PickList
            counter
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
              <text style={{ color: FAINT }}>{`rewinding here drops ${stats(preview().index).msgs} entries`}</text>
              {stats(preview().index).edits.map((m, i) => (
                <text key={i} style={{ color: FAINT }}>{`  ↩ ${m.title}`}</text>
              ))}
              <text> </text>
              <text style={{ color: FG }}>{preview().text.slice(0, 2000)}</text>
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
          counter
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

export function ResumePanel({ sessions, scopes, scopeIndex, loading, focused, currentId, onPick, onDelete, onClose }) {
  const [preview, setPreview] = createSignal(sessions[0] || null)
  const [query, setQuery] = createSignal('')
  const rankedSessions = rankFuzzy(sessions, query(), (q, session) => {
    const customScore = session.customTitle ? fuzzyScore(q, session.customTitle) : -1
    if (customScore >= 0) return 20_000 + customScore
    return fuzzyScore(q, session.automaticTitle || session.title)
  })
  const selectedSession = () => {
    if (loading) return null
    const selected = preview()
    return sessions.includes(selected) ? selected : null
  }
  useEscape(() => focused, onClose)
  useInput((event) => {
    if (!focused) return
    const selected = selectedSession()
    if (event.ctrl && event.key === 'x' && selected) {
      onDelete(selected)
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame
      title="Resume a session"
      hint="↑↓ to move · ctrl+s scope · enter to resume · ctrl+x delete · esc to close"
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
              counter
              items={rankedSessions}
              focused={focused && !loading}
              placeholder="filter sessions..."
              filter={() => true}
              onChange={setQuery}
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
                  {s.header.id === currentId && <text style={{ color: selected ? 'black' : accent(), dim: !selected }}> current</text>}
                  <text style={{ color: selected ? 'black' : FAINT, dim: !selected }}>{`  ${timeAgo(s.at)}`}</text>
                </box>
              )}
            />
          )}
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          {selectedSession() ? (
            <box style={{ flexDirection: 'column' }}>
              <text style={{ color: FAINT }}>{`${selectedSession().turns} ${selectedSession().turns === 1 ? 'turn' : 'turns'} · ${timeAgo(selectedSession().at)}`}</text>
              <text style={{ color: FAINT, overflow: 'truncate' }}>{shortenHome(selectedSession().header.root)}</text>
              <text> </text>
              <text style={{ color: FG }}>{selectedSession().title.slice(0, 500)}</text>
            </box>
          ) : (
            <text style={{ color: FAINT }}>no sessions</text>
          )}
        </box>
      </box>
    </PanelFrame>
  )
}

export function MemoryPanel({ memories, scopes, scopeIndex, focused, onForget, onClose }) {
  const [cursorItem, setCursorItem] = createSignal(null)
  const [pane, setPane] = createSignal('list')
  const preview = memories.includes(cursorItem()) ? cursorItem() : memories[0] || null
  useEscape(() => focused, onClose)
  useInput((event) => {
    if (!focused) return
    if (event.key === 'tab' && !event.ctrl && !event.meta) {
      setPane((p) => (p === 'list' ? 'preview' : 'list'))
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'x' && preview) {
      onForget(preview)
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame
      title="Memory"
      hint="↑↓ to move · tab: focus preview · ctrl+s scope · ctrl+x forget (twice) · esc to close"
      right={<ScopeTabs scopes={scopes} active={scopeIndex} />}
    >
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          {memories.length === 0 ? (
            <text style={{ color: FAINT }}>no memories here yet</text>
          ) : (
            <PickList
              counter
              items={memories}
              focused={focused && pane() === 'list'}
              placeholder="filter memories..."
              filter={(q, m) => fuzzyScore(q, `${m.name} ${m.description}`) >= 0}
              onCursorChange={setCursorItem}
              onSubmit={() => {}}
              onCancel={onClose}
              scrollbar
              gap={1}
              renderItem={(m, { selected, focused: f }) => (
                <box style={{ flexDirection: 'row', bg: selected ? (f ? accent() : SELECT_BG) : null, paddingX: 1 }}>
                  <box style={{ flexGrow: 1, height: 1 }}>
                    <text style={{ overflow: 'truncate', color: selected ? 'black' : FG }}>{m.name}</text>
                  </box>
                  <text style={{ color: selected ? 'black' : FAINT, dim: !selected }}>{`  ${m.scope}`}</text>
                </box>
              )}
            />
          )}
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          {preview ? (
            <ScrollBox style={{ flexGrow: 1 }} focused={focused && pane() === 'preview'} scrollbar>
              <text style={{ color: MUTED, italic: true }}>{preview.description || 'no description'}</text>
              <text> </text>
              <text style={{ color: FG_SOFT }}>{preview.body}</text>
            </ScrollBox>
          ) : (
            <text style={{ color: FAINT }}>no memories</text>
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
    <PanelFrame title="Thinking effort" hint="j/k to move · enter: this session · ctrl+s: set as default · esc: close">
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <Menu
          counter
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
              <text style={{ color: active ? accent() : FG }}>{label(l).padEnd(Math.max(10, label(l).length + 1))}</text>
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

export function ThemePanel({ themes, pref, focused, onPick, onPreview, onClose }) {
  const [cursor, setCursor] = createSignal(Math.max(0, themes.findIndex((t) => t.key === pref)))

  return (
    <PanelFrame title="Theme" hint="j/k to move and preview · enter to apply · esc: close">
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <Menu
          items={themes}
          selected={cursor()}
          onSelect={(i) => {
            setCursor(i)
            onPreview(themes[i])
          }}
          focused={focused}
          maxVisible={6}
          vimKeys
          onSubmit={onPick}
          onCancel={onClose}
          renderItem={(t, { active }) => (
            <box style={{ flexDirection: 'row' }}>
              <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
              <text style={{ color: active ? accent() : FG }}>{t.key.padEnd(Math.max(10, t.key.length + 1))}</text>
              <text style={{ color: FAINT }}>{t.desc}</text>
              {t.key === pref && <text style={{ color: active ? accent() : MUTED }}>{'  ✓'}</text>}
            </box>
          )}
        />
      </box>
    </PanelFrame>
  )
}

function ContextOverview({ overview }) {
  const reveal = useAnimated(0, ease(700))
  const layout = useLayout()
  reveal.set(1)
  const width = Math.max(1, layout.width || 1)
  const visible = Math.round(width * reveal())
  const total = overview.segments.reduce((sum, segment) => sum + segment.tokens, 0)
  let boundary = 0
  const cells = []

  for (let i = 0; i < width; i++) {
    const segment = overview.segments.find((item) => {
      boundary += item.tokens / total * width
      return i < boundary
    })
    boundary = 0
    cells.push(
      <text key={i} style={{ color: i >= visible ? PANEL_BG : segment?.color || FAINT }}>
        {i >= visible ? ' ' : segment ? '█' : '░'}
      </text>,
    )
  }

  const formatTokens = (tokens) => tokens < 1000 ? `${Math.round(tokens)} tok` : `${(tokens / 1000).toFixed(1)}k`
  const legendRows = () => {
    const rows = [[]]
    let used = 0
    for (const segment of overview.segments) {
      const itemWidth = segment.label.length + formatTokens(segment.tokens).length + 5
      if (used > 0 && used + itemWidth > Math.max(1, layout.width || 1)) {
        rows.push([])
        used = 0
      }
      rows.at(-1).push(segment)
      used += itemWidth
    }
    return rows
  }

  return (
    <box style={{ flexDirection: 'column', marginTop: 1 }}>
      <box style={{ flexDirection: 'row' }}>{cells}</box>
      <box style={{ flexDirection: 'column' }}>
        {legendRows().map((row, rowIndex) => (
          <box key={rowIndex} style={{ flexDirection: 'row' }}>
            {row.map((segment) => (
              <box key={segment.label} style={{ flexDirection: 'row', marginRight: 2 }}>
                <text style={{ color: segment.color }}>■</text>
                <text style={{ color: MUTED }}>{` ${segment.label} `}</text>
                <AnimatedValue
                  value={segment.tokens}
                  initial={0}
                  duration={2000}
                  color={FAINT}
                  highlight={accent()}
                  format={formatTokens}
                />
              </box>
            ))}
          </box>
        ))}
      </box>
    </box>
  )
}

export function InfoListPanel({ title, rows, overview, focused, onClose }) {
  useEscape(() => focused, onClose)

  return (
    <PanelFrame title={title} hint="j/k or ↑↓ to scroll · esc close">
      {overview && <ContextOverview overview={overview} />}
      <box style={{ flexDirection: 'column', height: 14, marginTop: 1 }}>
        {rows.length === 0 ? (
          <text style={{ color: FAINT }}>nothing here yet</text>
        ) : (
          <ScrollBox style={{ flexGrow: 1 }} focused={focused} scrollbar>
            {rows.map((row, i) => (
              <box key={`${row.name}-${i}`} style={{ flexDirection: 'column', marginTop: i === 0 ? 0 : 1 }}>
                <box style={{ flexDirection: 'row' }}>
                  <text style={{ color: accent() }}>{row.name}</text>
                  <box style={{ flexGrow: 1 }} />
                  {row.note && <text style={{ color: FAINT }}>{row.note}</text>}
                </box>
                <text style={{ color: MUTED }}>{row.desc || 'no description'}</text>
              </box>
            ))}
          </ScrollBox>
        )}
      </box>
    </PanelFrame>
  )
}

export function ProjectPanel({ projects, loading, focused, onPick, onDelete, onClose }) {
  const [preview, setPreview] = createSignal(projects[0] || null)
  const [query, setQuery] = createSignal('')
  const rankedProjects = rankFuzzy(projects, query(), (q, project) => fuzzyScore(q, project.path))
  useEscape(() => focused, onClose)
  useInput((event) => {
    if (!focused) return
    if (event.ctrl && event.key === 'x' && preview()) {
      onDelete(preview())
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame title="Switch project" hint="↑↓ to move · enter to jump to its last session · ctrl+x delete · esc to close">
      <box style={{ flexDirection: 'row', height: 12, marginTop: 1, gap: 2 }}>
        <box style={{ flexDirection: 'column', width: '50%' }}>
          {loading ? (
            <text style={{ color: MUTED }}>loading projects...</text>
          ) : projects.length === 0 ? (
            <text style={{ color: FAINT }}>no known projects yet</text>
          ) : (
            <PickList
              counter
              items={rankedProjects}
              focused={focused && !loading}
              placeholder="filter projects..."
              filter={() => true}
              onChange={setQuery}
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
              <text style={{ color: FAINT }}>{`${preview().count} ${preview().count === 1 ? 'session' : 'sessions'} · ${timeAgo(preview().latest.at)}`}</text>
              <text> </text>
              <text style={{ color: FG_SOFT }}>{`last: ${preview().latest.title.replace(/\n/g, ' ')}`}</text>
            </box>
          ) : (
            <text style={{ color: FAINT }}>no projects</text>
          )}
        </box>
      </box>
    </PanelFrame>
  )
}

export function ConnectPanel({ providers, focused, onConnect, onDisconnect, onClose }) {
  const [index, setIndex] = createSignal(0)
  useEscape(() => focused, onClose)

  const selected = () => providers[Math.min(index(), providers.length - 1)] || null

  useInput((event) => {
    if (!focused) return
    const p = selected()
    if (p && event.ctrl && event.key === 'x' && p.connected) {
      onDisconnect(p)
      event.stopPropagation()
    }
  })

  return (
    <PanelFrame title="Connect a subscription" hint="enter sign in · ctrl+x disconnect (twice) · esc close">
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <Menu
          counter
          items={providers}
          selected={index()}
          onSelect={setIndex}
          focused={focused}
          maxVisible={5}
          vimKeys
          onSubmit={(p) => onConnect(p)}
          onCancel={onClose}
          renderItem={(p, { active }) => (
            <box style={{ flexDirection: 'row' }}>
              <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
              <text style={{ color: p.connected ? accent() : MUTED }}>{p.connected ? '▪' : '▫'}</text>
              <text style={{ color: active ? accent() : FG }}>{` ${p.label}  `}</text>
              <box style={{ flexGrow: 1, height: 1 }}>
                <text style={{ overflow: 'truncate', color: MUTED }}>
                  {p.connected ? `connected${p.email ? ` as ${p.email}` : ''}` : 'not connected'}
                </text>
              </box>
            </box>
          )}
        />
      </box>
    </PanelFrame>
  )
}

export function WakeupsPanel({ wakeups, focused, onCancel, onClose }) {
  const [index, setIndex] = createSignal(0)
  const [tick, setTick] = createSignal(0)
  useEscape(() => focused, onClose)
  useInterval(() => setTick((t) => t + 1), 1000)
  void tick()

  const selected = () => wakeups[Math.min(index(), wakeups.length - 1)] || null

  useInput((event) => {
    if (!focused) return
    const w = selected()
    if (w && event.ctrl && event.key === 'x') {
      onCancel(w)
      event.stopPropagation()
    }
  })

  const countdown = (at) => {
    const secs = Math.max(0, Math.round((at - Date.now()) / 1000))
    if (secs < 60) return `in ${secs}s`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `in ${mins}m ${secs % 60}s`
    return `in ${Math.floor(mins / 60)}h ${mins % 60}m`
  }

  return (
    <PanelFrame title="Scheduled wake-ups" hint="j/k to move · enter or ctrl+x cancel (twice) · esc close">
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        {wakeups.length === 0 ? (
          <text style={{ color: FAINT }}>no pending wake-ups · the agent schedules them with schedule_wakeup</text>
        ) : (
          <Menu
            counter
            items={wakeups}
            selected={index()}
            onSelect={setIndex}
            focused={focused}
            maxVisible={5}
            itemHeight={2}
            gap={1}
            vimKeys
            onSubmit={(w) => onCancel(w)}
            onCancel={onClose}
            renderItem={(w, { active }) => (
              <box style={{ flexDirection: 'column' }}>
                <box style={{ flexDirection: 'row' }}>
                  <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                  <text style={{ color: active ? accent() : FG }}>{`⏰ ${w.id}`}</text>
                  <box style={{ flexGrow: 1 }} />
                  <text style={{ color: MUTED }}>{countdown(w.at)}</text>
                  <text style={{ color: FAINT }}>{`  ${new Date(w.at).toLocaleTimeString()}`}</text>
                </box>
                <box style={{ flexGrow: 1, height: 1, flexDirection: 'row' }}>
                  <text style={{ color: FAINT }}>{'    '}</text>
                  <text style={{ overflow: 'truncate', color: FG_SOFT }}>{w.note.replace(/\n/g, ' ')}</text>
                </box>
              </box>
            )}
          />
        )}
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

function FormField({ label, active, children }) {
  return (
    <box style={{ flexDirection: 'column' }}>
      <text style={{ color: active ? accent() : FAINT }}>{label}</text>
      {children}
      <text> </text>
    </box>
  )
}

function McpServerForm({ focused, server, onSave, onInvalid, onCancel }) {
  const initial = server ? parseServerSpec(server.command) : null
  const editing = !!server
  const [name, setName] = createSignal(server?.name || '')
  const [scope, setScope] = createSignal(server?.scope || 'global')
  const [transport, setTransport] = createSignal(initial?.type || 'stdio')
  const [target, setTarget] = createSignal(initial?.type === 'http' ? initial.url : server?.command || '')
  const initialHeaders = initial?.type === 'http'
    ? Object.fromEntries(Object.keys(initial.headers).map((name) => [name, REDACTED_HEADER]))
    : {}
  const [headers, setHeaders] = createSignal(formatHttpServerSpec('', initialHeaders).trim())

  const fm = useFocus({ initial: editing ? 'transport' : 'name' })
  if (!editing) {
    fm.item('name')
    fm.item('scope')
  }
  fm.item('transport')
  fm.item('target')
  if (transport() === 'http') fm.item('headers')
  fm.item('save')
  fm.item('cancel')

  useInput((event) => {
    if (!focused) return
    if (event.key === 'escape') {
      onCancel()
      event.stopPropagation()
    }
  })

  const http = transport() === 'http'

  const submit = () => {
    const serverName = name().trim()
    const value = target().trim()
    if (!serverName || /\s/.test(serverName)) return onInvalid('name is required and cannot contain spaces')
    if (!value) return onInvalid(http ? 'url is required' : 'command is required')
    if (http && !/^https?:\/\//.test(value)) return onInvalid('url must start with http:// or https://')
    if (!http && /^https?:\/\//.test(value)) return onInvalid('a stdio command cannot start with a url; pick the http transport')
    const extra = headers().trim()
    let spec = http && extra ? `${value} ${extra}` : value
    try {
      const parsed = parseServerSpec(spec)
      if (parsed.type === 'http' && initial?.type === 'http') {
        for (const [header, headerValue] of Object.entries(parsed.headers)) {
          if (headerValue === REDACTED_HEADER && initial.headers[header] !== undefined) parsed.headers[header] = initial.headers[header]
        }
        spec = formatHttpServerSpec(parsed.url, parsed.headers)
      }
    } catch (err) {
      return onInvalid(err.message)
    }
    onSave(serverName, spec, scope())
  }

  return (
    <box style={{ flexDirection: 'column', marginTop: 1 }}>
      {!editing && (
        <FormField label="name" active={fm.is('name')}>
          <box style={{ bg: PANEL_BG, paddingX: 1 }}>
            <TextInput focused={focused && fm.is('name')} placeholder="linear" onChange={setName} />
          </box>
        </FormField>
      )}
      {!editing && (
        <FormField label="scope" active={fm.is('scope')}>
          <Radio options={['global', 'project']} selected={scope()} onChange={setScope} focused={focused && fm.is('scope')} />
        </FormField>
      )}
      <FormField label="transport" active={fm.is('transport')}>
        <Radio options={['stdio', 'http']} selected={transport()} onChange={setTransport} focused={focused && fm.is('transport')} />
      </FormField>
      <FormField label={http ? 'url' : 'command'} active={fm.is('target')}>
        <box style={{ bg: PANEL_BG, paddingX: 1 }}>
          <TextInput
            focused={focused && fm.is('target')}
            placeholder={http ? 'https://mcp.linear.app/mcp' : 'npx -y @modelcontextprotocol/server-filesystem /tmp'}
            initialValue={target()}
            onChange={setTarget}
          />
        </box>
      </FormField>
      {http && (
        <FormField label="headers · optional" active={fm.is('headers')}>
          <box style={{ bg: PANEL_BG, paddingX: 1 }}>
            <TextInput focused={focused && fm.is('headers')} placeholder='Authorization="Bearer ..." X-Team="core"' initialValue={headers()} onChange={setHeaders} />
          </box>
        </FormField>
      )}
      <box style={{ flexDirection: 'row' }}>
        <Button label={editing ? 'save' : 'add'} onPress={submit} focused={focused && fm.is('save')} />
        <text>  </text>
        <Button label="cancel" onPress={onCancel} focused={focused && fm.is('cancel')} variant="dim" />
      </box>
    </box>
  )
}

export function McpPanel({ servers, focused, onToggle, onReconnect, onRemove, onAdd, onEdit, onInvalid, onClose }) {
  const [form, setForm] = createSignal(null)
  const [index, setIndex] = createSignal(0)
  const [viewing, setViewing] = createSignal(null)
  useEscape(() => focused && !form(), () => (viewing() ? setViewing(null) : onClose()))

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
      hint={form()
        ? 'tab moves between fields · j/k + space picks a radio option · esc cancels'
        : 'enter enable/disable · t tools · e edit · r reconnect · a add · ctrl+x remove (twice) · esc close'}
    >
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        {form() ? (
          <McpServerForm
            focused={focused}
            server={form() === 'add' ? null : form()}
            onSave={(name, spec, scope) => {
              if (form() === 'add') onAdd(name, spec, scope)
              else onEdit(name, spec)
              setForm(null)
            }}
            onInvalid={onInvalid}
            onCancel={() => setForm(null)}
          />
        ) : servers.length === 0 ? (
          <text style={{ color: FAINT }}>no MCP servers configured · press a to add one</text>
        ) : (
          <Menu
            counter
            items={servers}
            selected={index()}
            onSelect={setIndex}
            focused={focused}
            maxVisible={6}
            vimKeys
            itemHeight={2}
            onSubmit={(s) => onToggle(s.name)}
            onCancel={onClose}
            renderItem={(s, { active }) => {
              const st = MCP_STATUS[s.status] || MCP_STATUS.idle
              return (
                <box style={{ flexDirection: 'column' }}>
                  <box style={{ flexDirection: 'row' }}>
                    <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                    <text style={{ color: st.color }}>{st.icon}</text>
                    <text style={{ color: active ? accent() : FG }}>{` ${s.name.padEnd(Math.max(14, s.name.length + 1))}`}</text>
                    <box style={{ flexGrow: 1, height: 1 }}>
                      <text style={{ overflow: 'truncate', color: s.status === 'error' ? RED : MUTED }}>
                        {s.status === 'error' ? s.error : s.status === 'connected' ? `${s.toolCount} tools` : s.status}
                      </text>
                    </box>
                  </box>
                  <box style={{ flexDirection: 'row', height: 1 }}>
                    <text>{'     '}</text>
                    <box style={{ flexGrow: 1, height: 1 }}>
                      <text style={{ overflow: 'truncate', color: FAINT }}>{shortenHome(redactServerSpec(s.command))}</text>
                    </box>
                    <text style={{ color: FAINT }}>{`  ${s.scope === 'project' ? 'project' : 'global'}`}</text>
                  </box>
                </box>
              )
            }}
          />
        )}
      </box>
      {!form() && (
        <McpKeys
          focused={focused}
          onKey={(key) => {
            const s = selected()
            if (key === 'a') setForm('add')
            else if (s && key === 'e') setForm(s)
            else if (s && key === 'r') onReconnect(s.name)
            else if (s && key === 'remove') onRemove(s.name)
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
    if (event.ctrl && event.key === 'x') {
      onKey('remove')
      event.stopPropagation()
      return
    }
    if (!event.ctrl && ['a', 'e', 'r', 't'].includes(event.key)) {
      onKey(event.key)
      event.stopPropagation()
    }
  })
  return null
}
