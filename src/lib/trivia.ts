import { securePick } from "./rng.js";

/**
 * Trivia question banks for Selena.
 *
 * MLBB questions stick to well-established public facts (roles, lanes,
 * game modes, rank names, the Land of Dawn map) — no invented stats,
 * no hero damage numbers, no patch-specific figures.
 */
export interface TriviaQuestion {
  question: string;
  options: [string, string, string, string];
  answerIndex: number;
}

export type TriviaCategory = "mlbb" | "general";

export const MLBB_QUESTIONS: readonly TriviaQuestion[] = [
  {
    question: "What is the main objective in a Classic or Ranked MLBB match?",
    options: ["Destroy the enemy base", "Defeat 50 enemies", "Collect 100 gold", "Survive for 20 minutes"],
    answerIndex: 0,
  },
  {
    question: "How many players are on each team in a Classic MLBB match?",
    options: ["3", "4", "5", "6"],
    answerIndex: 2,
  },
  {
    question: "Which role usually plays in the Gold Lane?",
    options: ["Marksman", "Tank", "Support", "Jungler"],
    answerIndex: 0,
  },
  {
    question: "Which role usually plays in the EXP Lane?",
    options: ["Fighter", "Marksman", "Mage", "Support"],
    answerIndex: 0,
  },
  {
    question: "Which lane runs through the middle of the map?",
    options: ["Mid Lane", "Gold Lane", "EXP Lane", "Jungle"],
    answerIndex: 0,
  },
  {
    question: "What is the name of the main 5v5 map in MLBB?",
    options: ["Land of Dawn", "Celestial Palace", "Summoner's Rift", "Abyssal Arena"],
    answerIndex: 0,
  },
  {
    question: "Which neutral monster appears early in the game and grants gold and EXP to the whole team?",
    options: ["Turtle", "Lord", "Crab", "Golem"],
    answerIndex: 0,
  },
  {
    question: "What does the Lord do for the team that defeats it?",
    options: [
      "It spawns and pushes a lane for them",
      "It heals the whole team to full",
      "It destroys all enemy turrets instantly",
      "It ends the match",
    ],
    answerIndex: 0,
  },
  {
    question: "Which rank comes immediately after Epic?",
    options: ["Legend", "Mythic", "Grandmaster", "Master"],
    answerIndex: 0,
  },
  {
    question: "Which is the highest rank tier before Mythical Glory?",
    options: ["Mythic", "Legend", "Mythical Honor", "Epic"],
    answerIndex: 0,
  },
  {
    question: "What is the lowest rank tier in MLBB?",
    options: ["Warrior", "Elite", "Master", "Bronze"],
    answerIndex: 0,
  },
  {
    question: "What currency earned from matches is mainly used to buy heroes?",
    options: ["Battle Points", "Diamonds", "Tickets", "Magic Dust"],
    answerIndex: 0,
  },
  {
    question: "Which role deals sustained damage from range, mostly with basic attacks?",
    options: ["Marksman", "Tank", "Fighter", "Support"],
    answerIndex: 0,
  },
  {
    question: "Which role is usually the Roamer, protecting teammates and setting up fights?",
    options: ["Tank", "Marksman", "Mage", "Assassin"],
    answerIndex: 0,
  },
  {
    question: 'What does "gank" mean in MLBB?',
    options: [
      "Ambushing an enemy lane with teammates",
      "Farming jungle monsters alone",
      "Destroying a turret by yourself",
      "Recalling back to base",
    ],
    answerIndex: 0,
  },
  {
    question: "What is a turret in MLBB?",
    options: [
      "A defensive structure that guards a lane",
      "A jungle monster",
      "A hero's ultimate skill",
      "A type of emblem",
    ],
    answerIndex: 0,
  },
  {
    question: "What is the maximum hero level you can reach in a match?",
    options: ["10", "12", "15", "20"],
    answerIndex: 2,
  },
  {
    question: "Which hero is a Tank known for pulling enemies together with his ultimate, Implosion?",
    options: ["Tigreal", "Layla", "Eudora", "Miya"],
    answerIndex: 0,
  },
  {
    question: "Which hero is a Marksman famous for her very long attack range?",
    options: ["Layla", "Tigreal", "Franco", "Chou"],
    answerIndex: 0,
  },
  {
    question: "Which hero is a Mage who fights by controlling an umbrella?",
    options: ["Kagura", "Alucard", "Balmond", "Lesley"],
    answerIndex: 0,
  },
  {
    question: 'Which hero is known for the skill "Abyssal Arrow"?',
    options: ["Selena", "Gusion", "Fanny", "Valir"],
    answerIndex: 0,
  },
  {
    question: "Which company develops and publishes Mobile Legends: Bang Bang?",
    options: ["Moonton", "Riot Games", "Valve", "Tencent"],
    answerIndex: 0,
  },
  {
    question: 'What does "push" mean in MLBB?',
    options: [
      "Advancing by attacking enemy turrets and minions",
      "Retreating back to base",
      "Buying items from the shop",
      "Hiding in a bush",
    ],
    answerIndex: 0,
  },
  {
    question: "Which game mode is a fast 5v5 match with random heroes on a single lane?",
    options: ["Brawl", "Ranked", "Classic", "Custom"],
    answerIndex: 0,
  },
];

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

/** Pick a random question from a category's bank. */
export function pickTriviaQuestion(category: TriviaCategory): TriviaQuestion {
  const bank = category === "mlbb" ? MLBB_QUESTIONS : GENERAL_QUESTIONS;
  return securePick(bank);
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
