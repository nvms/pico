import { createSignal, Button, TextInput, useInput } from '@trendr/core'
import { accent, FAINT, FG, FG_SOFT, MUTED, PANEL_BG, SELECT_BG } from './theme.js'

function answerText(question, answer) {
  if (Array.isArray(answer)) return answer.join(', ')
  return answer || 'Not answered'
}

export function QuestionForm({ request, focused, onSubmit, onCancel }) {
  const questions = request.questions
  const reviewing = questions.length > 1
  const [step, setStep] = createSignal(0)
  const [answers, setAnswers] = createSignal({})
  const [cursor, setCursor] = createSignal(0)
  const [custom, setCustom] = createSignal(false)
  const [review, setReview] = createSignal(false)
  const [control, setControl] = createSignal('answer')

  const question = () => questions[step()]
  const options = () => question().options || []
  const rows = () => [...options(), ...(question().allowOther === false ? [] : [{ label: 'Other', other: true }])]
  const selected = (label) => (answers()[question().id] || []).includes(label)
  const otherAnswer = () => {
    const answer = answers()[question().id]
    const labels = new Set(options().map((option) => option.label))
    if (Array.isArray(answer)) return answer.find((value) => !labels.has(value)) || ''
    return answer && !labels.has(answer) ? answer : ''
  }

  function setAnswer(value) {
    setAnswers((current) => ({ ...current, [question().id]: value }))
  }

  function advance() {
    setCustom(false)
    setCursor(0)
    setControl('answer')
    if (step() < questions.length - 1) setStep(step() + 1)
    else if (reviewing) { setCursor(questions.length); setReview(true) }
    else finish()
  }

  function finish() {
    onSubmit(questions.map((item) => ({ id: item.id, question: item.question, answer: answers()[item.id] ?? '' })))
  }

  function submitText(value) {
    const answer = value.trim()
    if (!answer) return
    setAnswer(answer)
    if (questions.length === 1) onSubmit([{ id: item.id, question: item.question, answer }])
    else advance()
  }

  function submitOther(value) {
    const answer = value.trim()
    const known = new Set((item.options || []).map((option) => option.label))
    const choices = item.type === 'multi' ? (answers()[item.id] || []).filter((entry) => known.has(entry)) : []
    const nextAnswer = item.type === 'multi' ? [...choices, ...(answer ? [answer] : [])] : answer
    setAnswer(nextAnswer)
    setCustom(false)
    if (item.type === 'single' && answer) {
      if (questions.length === 1) onSubmit([{ id: item.id, question: item.question, answer }])
      else advance()
    }
  }

  useInput((event) => {
    if (!focused) return
    if (event.key === 'escape') {
      if (custom()) { setCustom(false); setControl('answer') }
      else if (review()) setReview(false)
      else onCancel()
      event.stopPropagation()
      return
    }
    if (review()) {
      if (event.key === 'up' || event.key === 'k') setCursor(Math.max(0, cursor() - 1))
      else if (event.key === 'down' || event.key === 'j') setCursor(Math.min(questions.length, cursor() + 1))
      else if (event.key === 'return') {
        if (cursor() === questions.length) finish()
        else { setStep(cursor()); setCursor(0); setControl('answer'); setReview(false) }
      } else return
      event.stopPropagation()
      return
    }
    if (step() > 0 && (event.key === 'tab' || event.key === 'shift-tab')) {
      setControl(control() === 'back' ? 'answer' : 'back')
      event.stopPropagation()
      return
    }
    if (control() === 'back') return
    if (custom()) {
      if (event.key === 'tab' || event.key === 'shift-tab') {
        setCustom(false)
        setControl('answer')
        event.stopPropagation()
      }
      return
    }
    if (question()?.type === 'text') return
    if (event.key === 'up' || event.key === 'k') setCursor(Math.max(0, cursor() - 1))
    else if (event.key === 'down' || event.key === 'j') setCursor(Math.min(rows().length - 1, cursor() + 1))
    else if (event.key === 'space' && question().type === 'multi') {
      const row = rows()[cursor()]
      if (row.other) {
        if (otherAnswer()) {
          const known = new Set(options().map((option) => option.label))
          setAnswer((answers()[question().id] || []).filter((entry) => known.has(entry)))
          setCustom(false)
        } else setCustom(true)
      } else {
        const current = answers()[question().id] || []
        setAnswer(current.includes(row.label) ? current.filter((value) => value !== row.label) : [...current, row.label])
      }
    } else if (event.key === 'return') {
      const row = rows()[cursor()]
      if (question().type === 'multi') advance()
      else if (row.other) setCustom(true)
      else {
        setAnswer(row.label)
        if (questions.length === 1) onSubmit([{ id: question().id, question: question().question, answer: row.label }])
        else advance()
      }
    } else return
    event.stopPropagation()
  })

  if (review()) {
    return (
      <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 2, paddingY: 1, marginTop: 1 }}>
        <box style={{ flexDirection: 'row' }}>
          <text style={{ color: accent(), bold: true }}>Review answers</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ color: FAINT }}>enter: edit or submit · esc: back</text>
        </box>
        {questions.map((item, index) => (
          <box style={{ flexDirection: 'column', bg: cursor() === index ? SELECT_BG : undefined, paddingX: 1 }}>
            <text style={{ color: cursor() === index ? accent() : FG }}>{item.question}</text>
            <text style={{ color: MUTED }}>{answerText(item, answers()[item.id])}</text>
          </box>
        ))}
        <text style={{ bg: cursor() === questions.length ? accent() : undefined, color: cursor() === questions.length ? 'black' : FG, bold: true }}> Submit answers </text>
      </box>
    )
  }

  const item = question()
  const progress = questions.length > 1 ? `${step() + 1} of ${questions.length}` : 'Question'
  return (
    <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 2, paddingY: 1, marginTop: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        {step() > 0 && (
          <box style={{ flexDirection: 'row' }}>
            <Button
              label="Back"
              focused={focused && control() === 'back'}
              onPress={() => {
                setStep(step() - 1)
                setCursor(0)
                setCustom(false)
                setControl('answer')
              }}
            />
            <text>  </text>
          </box>
        )}
        <text style={{ color: accent(), bold: true }}>{progress}</text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ color: FAINT }}>{item.type === 'multi' ? 'space: select · enter: continue' : 'enter: answer'} · esc: cancel</text>
      </box>
      <text style={{ color: FG, bold: true }}>{item.question}</text>
      {item.description && <text style={{ color: MUTED }}>{item.description}</text>}
      {item.type === 'text' ? (
        <box style={{ bg: SELECT_BG, paddingX: 1, marginTop: 1 }}>
          <TextInput
            key={`${item.id}:text`}
            focused={focused && control() === 'answer'}
            placeholder="Type your answer"
            initialValue={typeof answers()[item.id] === 'string' ? answers()[item.id] : ''}
            onSubmit={submitText}
          />
        </box>
      ) : (
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          {rows().map((option, index) => (
            <box style={{ flexDirection: 'column', bg: cursor() === index ? SELECT_BG : undefined, paddingX: 1 }}>
              <text style={{ color: cursor() === index ? accent() : FG_SOFT }}>
                {item.type === 'multi'
                  ? `${option.other ? (otherAnswer() ? '[x]' : '[ ]') : (selected(option.label) ? '[x]' : '[ ]')} `
                  : `${cursor() === index ? '›' : ' '} `}{option.label}
              </text>
              {option.description && <text style={{ color: FAINT }}>{` · ${option.description}`}</text>}
              {option.other && (custom() || otherAnswer()) && (
                <box style={{ bg: custom() ? PANEL_BG : undefined, paddingLeft: 4 }}>
                  <TextInput
                    key={`${item.id}:other`}
                    focused={focused && custom()}
                    placeholder="Type another answer"
                    initialValue={otherAnswer()}
                    onSubmit={submitOther}
                  />
                </box>
              )}
            </box>
          ))}
        </box>
      )}
    </box>
  )
}
