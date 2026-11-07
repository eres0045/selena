import { secureInt, securePick } from "./rng.js";

/**
 * Trivia question bank for Selena (general knowledge only — the MLBB
 * category was removed 2026-11-07 on Ronit's order, no MLBB anything).
 */
export interface TriviaQuestion {
  question: string;
  options: [string, string, string, string];
  answerIndex: number;
}

export const GENERAL_QUESTIONS: readonly TriviaQuestion[] = [
  {
    question: "What is the capital of France?",
    options: ["Paris", "London", "Berlin", "Madrid"],
    answerIndex: 0,
  },
  {
    question: "Which is the largest planet in our solar system?",
    options: ["Jupiter", "Saturn", "Neptune", "Mars"],
    answerIndex: 0,
  },
  {
    question: "What is the chemical symbol for water?",
    options: ["H2O", "CO2", "O2", "NaCl"],
    answerIndex: 0,
  },
  {
    question: "How many continents are there on Earth?",
    options: ["7", "5", "6", "8"],
    answerIndex: 0,
  },
  {
    question: "Who painted the Mona Lisa?",
    options: ["Leonardo da Vinci", "Pablo Picasso", "Vincent van Gogh", "Claude Monet"],
    answerIndex: 0,
  },
  {
    question: "What is the fastest land animal?",
    options: ["Cheetah", "Lion", "Horse", "Gazelle"],
    answerIndex: 0,
  },
  {
    question: "Which is the largest ocean on Earth?",
    options: ["Pacific Ocean", "Atlantic Ocean", "Indian Ocean", "Arctic Ocean"],
    answerIndex: 0,
  },
  {
    question: "How many sides does a hexagon have?",
    options: ["6", "5", "7", "8"],
    answerIndex: 0,
  },
  {
    question: "What is the capital of Japan?",
    options: ["Tokyo", "Kyoto", "Osaka", "Seoul"],
    answerIndex: 0,
  },
  {
    question: "What gas do plants absorb from the air for photosynthesis?",
    options: ["Carbon dioxide", "Oxygen", "Nitrogen", "Hydrogen"],
    answerIndex: 0,
  },
  {
    question: "At sea level, at what temperature does water boil?",
    options: ["100°C", "90°C", "80°C", "120°C"],
    answerIndex: 0,
  },
  {
    question: "What is the largest mammal in the world?",
    options: ["Blue whale", "African elephant", "Giraffe", "Hippopotamus"],
    answerIndex: 0,
  },
  {
    question: "How many minutes are there in 3 hours?",
    options: ["180", "120", "240", "90"],
    answerIndex: 0,
  },
  {
    question: "Who was the first President of the United States?",
    options: ["George Washington", "Abraham Lincoln", "Thomas Jefferson", "John Adams"],
    answerIndex: 0,
  },
  {
    question: "Which musical instrument has 88 keys?",
    options: ["Piano", "Guitar", "Violin", "Harp"],
    answerIndex: 0,
  },
  {
    question: "What is the capital of Australia?",
    options: ["Canberra", "Sydney", "Melbourne", "Perth"],
    answerIndex: 0,
  },
  {
    question: "What is the main language spoken in Brazil?",
    options: ["Portuguese", "Spanish", "French", "Italian"],
    answerIndex: 0,
  },
  {
    question: "How many colours are traditionally in a rainbow?",
    options: ["7", "5", "6", "8"],
    answerIndex: 0,
  },
  {
    question: "What is the smallest prime number?",
    options: ["2", "1", "3", "0"],
    answerIndex: 0,
  },
  {
    question: "Which metal is liquid at room temperature?",
    options: ["Mercury", "Iron", "Copper", "Aluminium"],
    answerIndex: 0,
  },
  {
    question: "Who wrote Romeo and Juliet?",
    options: ["William Shakespeare", "Charles Dickens", "Jane Austen", "Mark Twain"],
    answerIndex: 0,
  },
  {
    question: "How many days are there in a leap year?",
    options: ["366", "365", "364", "367"],
    answerIndex: 0,
  },
];

/**
 * Pick a random question from the bank, with the 4 options shuffled so the
 * correct answer is not always in the same slot. The bank itself is the
 * source of truth (every entry there has answerIndex 0, i.e. the correct
 * option listed first); the shuffle happens here at pick time and the
 * returned answerIndex is remapped to the shuffled position of the correct
 * option. Callers render `options` in order and check `answerIndex`, so a
 * shuffled pick fixes both the displayed letters and the buttons.
 */
export function pickTriviaQuestion(): TriviaQuestion {
  const base = securePick(GENERAL_QUESTIONS);
  const correct = base.options[base.answerIndex]!;
  const options = [...base.options] as TriviaQuestion["options"];
  // Fisher-Yates shuffle, crypto-backed via secureInt.
  for (let i = options.length - 1; i > 0; i--) {
    const j = secureInt(0, i + 1);
    [options[i], options[j]] = [options[j]!, options[i]!];
  }
  // Options are distinct (see validateBank), so indexOf is unambiguous.
  return { question: base.question, options, answerIndex: options.indexOf(correct) };
}

/** True when the chosen option index is the question's answer. */
export function isTriviaAnswerCorrect(question: TriviaQuestion, chosenIndex: number): boolean {
  return chosenIndex === question.answerIndex;
}

/** Validate a bank: every question has exactly 4 distinct options and a valid answerIndex. */
export function validateBank(bank: readonly TriviaQuestion[]): string[] {
  const problems: string[] = [];
  bank.forEach((q, i) => {
    if (q.options.length !== 4) problems.push(`Q${i}: expected 4 options, got ${q.options.length}`);
    if (q.answerIndex < 0 || q.answerIndex > 3) problems.push(`Q${i}: answerIndex ${q.answerIndex} out of range`);
    if (new Set(q.options).size !== q.options.length) problems.push(`Q${i}: duplicate options`);
    if (!q.question.trim()) problems.push(`Q${i}: empty question`);
  });
  return problems;
}
