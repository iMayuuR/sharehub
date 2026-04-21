// identity.js
const ADJECTIVES = ['Neon', 'Cyber', 'Cosmic', 'Quantum', 'Hyper', 'Turbo', 'Lunar', 'Solar', 'Astro', 'Plasma'];
const NOUNS = ['Tiger 🐯', 'Monkey 🐒', 'Dolphin 🐬', 'Cheetah 🐆', 'Panda 🐼', 'Cat 🐱', 'Dog 🐶', 'Bunny 🐰', 'Penguin 🐧', 'Koala 🐨'];

export function generateIdentity() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return {
    name: `${adj} ${noun}`,
    avatar: noun.split(' ')[1] || '😎',
    id: Math.random().toString(36).substring(2, 12)
  };
}

export function getIdentity() {
  const stored = localStorage.getItem('sharehub-identity');
  if (stored) return JSON.parse(stored);
  
  const newIdentity = generateIdentity();
  saveIdentity(newIdentity);
  return newIdentity;
}

export function saveIdentity(identity) {
  localStorage.setItem('sharehub-identity', JSON.stringify(identity));
}
