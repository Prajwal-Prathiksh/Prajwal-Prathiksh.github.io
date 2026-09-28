// Rules for Wordling: guess a five-letter word in six tries.

import answersText from '../data/wordling/answers.txt?raw';
import guessesText from '../data/wordling/guesses.txt?raw';

export type Mark = 'correct' | 'present' | 'absent';

export const LENGTH = 5;
export const TRIES = 6;

const answers = answersText.split('\n').filter(Boolean);
const valid = new Set([...guessesText.split('\n').filter(Boolean), ...answers]);

export const isValid = (word: string) => valid.has(word);

export function randomAnswer(avoid: Set<string>): string {
  for (;;) {
    const word = answers[Math.floor(Math.random() * answers.length)];
    if (!avoid.has(word) || avoid.size >= answers.length) return word;
  }
}

// Two passes, so a repeated letter is only marked as often as the answer has it.
export function evaluate(guess: string, answer: string): Mark[] {
  const marks: Mark[] = Array(LENGTH).fill('absent');
  const left: Record<string, number> = {};
  for (let i = 0; i < LENGTH; i++) {
    if (guess[i] === answer[i]) marks[i] = 'correct';
    else left[answer[i]] = (left[answer[i]] ?? 0) + 1;
  }
  for (let i = 0; i < LENGTH; i++) {
    if (marks[i] !== 'correct' && left[guess[i]]) {
      marks[i] = 'present';
      left[guess[i]]--;
    }
  }
  return marks;
}

const ordinal = (n: number) => ['1st', '2nd', '3rd', '4th', '5th'][n];

// Hard mode: every hint revealed so far must be used. Returns the broken rule, if any.
export function hardModeError(guess: string, history: { word: string; marks: Mark[] }[]): string | null {
  for (const { word, marks } of history) {
    for (let i = 0; i < LENGTH; i++) {
      if (marks[i] === 'correct' && guess[i] !== word[i]) {
        return `${ordinal(i)} letter must be ${word[i].toUpperCase()}`;
      }
    }
    const needed: Record<string, number> = {};
    word.split('').forEach((c, i) => {
      if (marks[i] !== 'absent') needed[c] = (needed[c] ?? 0) + 1;
    });
    for (const [c, n] of Object.entries(needed)) {
      if (guess.split(c).length - 1 < n) return `Guess must contain ${c.toUpperCase()}`;
    }
  }
  return null;
}
