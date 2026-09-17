import { createSignal, TextArea, Menu, Button, useInput } from '@trendr/core'
import { fuzzyScore, rankFuzzy } from 'picocode-core/fuzzy.js'
import { accent, FG, MUTED, PANEL_BG } from './theme.js'

export function CommandForm({ name, fields, files, focused, onSubmit, onCancel }) {
  const [step, setStep] = createSignal(0)
  const [values, setValues] = createSignal({})
  const [query, setQuery] = createSignal('')
  const [selected, setSelected] = createSignal(0)
  const field = fields[step()]
  const options = field.type === 'choice' ? field.choices : field.type === 'path' ? files : []
  const matches = rankFuzzy(options, query(), (q, value) => fuzzyScore(q, value))

  function advance(value) {
    const next = { ...values(), [field.name]: value }
    setValues(next)
    if (step() === fields.length - 1) return onSubmit(next)
    setStep(step() + 1)
    setQuery('')
    setSelected(0)
  }

  useInput((event) => {
    if (!focused) return
    if (event.key === 'escape') {
      onCancel()
      event.stopPropagation()
    }
  })

  return (
    <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 2, paddingY: 1 }}>
      <box style={{ flexDirection: 'row', gap: 2 }}>
        <text style={{ color: accent(), bold: true }}>{`/${name}`}</text>
        {fields.slice(0, step()).map((item) => <text key={item.name} style={{ color: MUTED }}>{values()[item.name]}</text>)}
        <Button label="Cancel" onPress={onCancel} />
      </box>
      <text style={{ color: FG }}>{field.label}</text>
      <TextArea
        key={field.name}
        focused={focused}
        value={query()}
        submitOnEnter
        clearOnSubmit={false}
        maxHeight={1}
        placeholder={field.label}
        onCancel={onCancel}
        onChange={(value) => { setQuery(value); setSelected(0) }}
        onSubmit={(value) => {
          if (field.type === 'choice') {
            if (matches.length) advance(matches[Math.min(selected(), matches.length - 1)])
          } else advance(field.type === 'path' && matches.length && !value.startsWith('/') && !value.startsWith('~') ? matches[Math.min(selected(), matches.length - 1)] : value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'down' && matches.length) {
            setSelected(Math.min(selected() + 1, matches.length - 1))
            return true
          }
          if (event.key === 'up' && matches.length) {
            setSelected(Math.max(0, selected() - 1))
            return true
          }
          if (event.key === 'tab' && matches.length) {
            setQuery(matches[Math.min(selected(), matches.length - 1)])
            return true
          }
          return false
        }}
      />
      {matches.length > 0 && <Menu
        items={matches}
        selected={selected()}
        onSelect={setSelected}
        onSubmit={advance}
        focused={false}
        maxVisible={5}
        renderItem={(value, { active }) => <text style={{ color: active ? accent() : MUTED }}>{`${active ? '› ' : '  '}${value}`}</text>}
      />}
    </box>
  )
}
