import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanDictation } from '../src/dictation-text.js'

for (const word of ['uh', 'um', 'Uh', 'Um', 'UH', 'UM']) {
  for (const punctuation of ['', ',', ';', ':']) {
    test(`cleans ${word}${punctuation} at sentence boundaries and inside sentences`, () => {
      assert.equal(cleanDictation(`${word}${punctuation} use the filter.`), 'Use the filter.')
      assert.equal(cleanDictation(`Use ${word}${punctuation} the filter.`), 'Use the filter.')
      assert.equal(cleanDictation(`Use, ${word}${punctuation} the filter.`), 'Use the filter.')
      assert.equal(cleanDictation(`Use the filter, ${word}${punctuation}`), 'Use the filter')
      assert.equal(cleanDictation(`Use the filter. ${word}${punctuation}`), 'Use the filter.')
    })
  }
}

const cases = [
  ['Use the filter, uh.', 'Use the filter.'],
  ['Use the filter; um?', 'Use the filter?'],
  ['Use the filter uh!', 'Use the filter!'],
  ['Um. use the filter.', 'Use the filter.'],
  ['Use it. Um, does it work?', 'Use it. Does it work?'],
  ['Use it uh. does it work?', 'Use it. Does it work?'],
  ['Use it; um, then test it.', 'Use it; then test it.'],
  ['Use this: uh, the filter.', 'Use this: the filter.'],
  ['Uh, um; uh use it, um, uh.', 'Use it.'],
  ['Use uh um the filter.', 'Use the filter.'],
  ['Uh, um; uh.', ''],
  ['Um', ''],
  ['', ''],
  ['   ', ''],
  ['Use\tuh,\t the filter.', 'Use the filter.'],
  ['Uh, use it.\nUm; test it.', 'Use it.\nTest it.'],
  ['Use it.\n\nUm, test it.', 'Use it.\n\nTest it.'],
  ['Uh, élève.', 'Élève.'],
  ['Uh, iPhone works.', 'iPhone works.'],
  ["Okay. I'm also considering having a change log baked into the application. Uh probably not fetched remotely, right? Just like in the app. Um does it belong on that page too?", "Okay. I'm also considering having a change log baked into the application. Probably not fetched remotely, right? Just like in the app. Does it belong on that page too?"],
]

for (const [input, expected] of cases) {
  test(`cleans ${JSON.stringify(input)}`, () => {
    assert.equal(cleanDictation(input), expected)
    assert.equal(cleanDictation(expected), expected)
  })
}

test('preserves other words, quoted literals, compounds, and unrelated punctuation', () => {
  for (const text of [
    'Well, like, right, okay, actually, you know.',
    'Thumb, human, umbrella, album, uhuru, scrum.',
    'uh-huh, um-hum, uh_thing, um2, éum, umé.',
    'Keep "um", \'uh\', `um`, and “uh”.',
    'Keep (um) and [uh].',
    'Keep  two spaces; punctuation: really?!\n\nYes.',
    'Use /um/path and example.um.',
  ]) assert.equal(cleanDictation(text), text)
})
