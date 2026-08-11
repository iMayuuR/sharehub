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

/**
 * A stable, friendly name for a peer we have heard of but not yet heard from.
 * Derived from the peer id, so both ends show the same thing, and it replaces
 * the "Unknown Device" placeholder that used to sit there until the peer's own
 * announcement arrived — or forever, if it never did.
 */
export function identityForPeer(peerId) {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) hash = (Math.imul(hash, 31) + peerId.charCodeAt(i)) | 0;
  hash = Math.abs(hash);

  const noun = NOUNS[hash % NOUNS.length];
  return {
    name: `${ADJECTIVES[(hash >> 5) % ADJECTIVES.length]} ${noun}`,
    avatar: noun.split(' ')[1] || '😎',
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
