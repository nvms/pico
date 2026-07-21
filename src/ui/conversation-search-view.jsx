import { createSignal, TextInput, useLayout } from '@trendr/core'
import { Message } from './transcript.jsx'
import { accent, FG, MUTED, PANEL_BG } from './theme.js'
import { conversationMatches, highlightConversation } from './conversation-search.js'

function ScrollAnchor({ target }) {
  const layout = useLayout()
  target.anchorY = layout.y
  return null
}

function SearchMessage({ item, verbose, currentMatch, search }) {
  const layout = useLayout()
  if (currentMatch) search.scrollToMatch(layout, currentMatch)
  return <Message item={item} verbose={verbose} />
}

export function createConversationSearch({ fm, verbose, setFollow, setOffset }) {
  const [active, setActive] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [committed, setCommitted] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const [enterFocus, setEnterFocus] = createSignal(false)
  const [scroll] = createSignal({ anchorY: 0, key: null })

  function registerFocus() {
    if (!active()) return
    fm.item('conversation-search')
    if (enterFocus()) {
      setEnterFocus(false)
      fm.focus('conversation-search')
    }
  }

  function open() {
    setActive(true)
    setQuery('')
    setCommitted(false)
    setIndex(0)
    setEnterFocus(true)
  }

  function close({ restoreFocus = true } = {}) {
    setActive(false)
    setQuery('')
    setCommitted(false)
    setIndex(0)
    if (restoreFocus && fm.is('conversation-search')) fm.focus('feed')
  }

  function handleInput(event, matches) {
    if (active() && !fm.is('conversation-search')) {
      close({ restoreFocus: false })
      return true
    }
    if (!active() || !committed()) return false
    const count = matches.length
    if (event.key === 'escape') close()
    else if (event.key === 'n' && !event.shift) {
      if (count) setIndex((index() + 1) % count)
    } else if (event.key === 'N' || (event.shift && event.key === 'n')) {
      if (count) setIndex((index() - 1 + count) % count)
    } else if (event.ctrl && event.key === 'o') return false
    else return true
    event.stopPropagation()
    return true
  }

  function prepare(items) {
    const matches = conversationMatches(items, query(), verbose())
    const lastIndex = Math.max(0, matches.length - 1)
    if (index() > lastIndex) setIndex(lastIndex)
    return {
      matches,
      items: active() ? highlightConversation(items, query(), index(), verbose()) : items,
    }
  }

  function scrollToMatch(layout, match) {
    const target = scroll()
    const key = `${query()}\0${index()}\0${verbose()}`
    if (target.key === key) return
    target.key = key
    setFollow(false)
    setOffset(Math.max(0, layout.y - target.anchorY + match.line - 3))
  }

  function updateQuery(value) {
    setQuery(value)
    setIndex(0)
  }

  return {
    active,
    query,
    committed,
    index,
    focused: () => fm.is('conversation-search'),
    registerFocus,
    open,
    close,
    handleInput,
    prepare,
    scroll: scroll(),
    scrollToMatch,
    commit: () => setCommitted(true),
    updateQuery,
  }
}

export function ConversationSearchBar({ search, matches }) {
  return (
    <box style={{ flexDirection: 'row', flexShrink: 0, height: 1, bg: PANEL_BG, paddingX: 2 }}>
      <text style={{ color: accent() }}>{'/ '}</text>
      {search.committed()
        ? <text style={{ color: FG, flexGrow: 1 }}>{search.query()}</text>
        : <TextInput
            focused={search.focused()}
            value={search.query()}
            onChange={search.updateQuery}
            onSubmit={search.commit}
            onCancel={search.close}
          />}
      <text style={{ color: MUTED }}>{matches.length ? `${search.index() + 1}/${matches.length}` : '0/0'}</text>
    </box>
  )
}

export { ScrollAnchor as ConversationScrollAnchor, SearchMessage as ConversationSearchMessage }
