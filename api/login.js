// Serverless function to handle login
export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PASSWORD = process.env.SITE_PASSWORD || 'thirdspace2026';
  const { password } = req.body || {};

  if (password === PASSWORD) {
    // Set auth cookie — 30 day expiry
    res.setHeader(
      'Set-Cookie',
      `tsc_auth=${PASSWORD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
    );
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ error: 'Invalid password' });
}
