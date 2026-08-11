// Fallback handler for /share POST when Service Worker isn't installed yet.
// Vercel serverless function: receives POST, redirects to app with ?shared=pending
// The actual file handling happens client-side after redirect.
export default function handler(req, res) {
  if (req.method === 'POST') {
    // Can't store files in serverless, redirect to app which will guide user
    res.redirect(303, '/?shared=pending');
  } else {
    res.redirect(303, '/');
  }
}
