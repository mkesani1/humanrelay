// Edge Middleware — Password protection for Third Space Cafe dashboard
// Set your password via Vercel Environment Variable: SITE_PASSWORD
// Default password (change in Vercel dashboard): thirdspace2026

export default function middleware(request) {
  const PASSWORD = process.env.SITE_PASSWORD || 'thirdspace2026';
  const COOKIE_NAME = 'tsc_auth';
  const url = new URL(request.url);

  if (url.pathname === '/api/login') {
    return undefined;
  }

  const cookie = request.headers.get('cookie') || '';
  const cookies = Object.fromEntries(
    cookie.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );

  if (cookies[COOKIE_NAME] === PASSWORD) {
    return undefined;
  }

  const loginHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Third Space Cafe — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; position: relative; overflow: hidden; }
    body::before { content: ''; position: fixed; top: -10%; right: -5%; width: 600px; height: 600px; background: radial-gradient(circle, rgba(13, 148, 136, 0.08) 0%, transparent 70%); border-radius: 50%; z-index: -1; }
    .login-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 3rem; width: 100%; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); text-align: center; }
    .logo { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-bottom: 1.5rem; }
    .logo svg { width: 32px; height: 32px; color: #0d9488; }
    .logo span { font-weight: 600; font-size: 1.25rem; color: #0f172a; }
    .subtitle { color: #64748b; font-size: 0.9rem; margin-bottom: 2rem; }
    input[type="password"] { width: 100%; padding: 0.75rem 1rem; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 1rem; font-family: inherit; margin-bottom: 1rem; transition: border-color 0.2s; }
    input[type="password"]:focus { outline: none; border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.1); }
    button { width: 100%; padding: 0.75rem; background: #0d9488; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #0f766e; }
    .error { color: #dc2626; font-size: 0.85rem; margin-top: 0.75rem; display: none; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 8h1a4 4 0 1 1 0 8h-1"/>
        <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/>
        <line x1="6" y1="2" x2="6" y2="4"/>
        <line x1="10" y1="2" x2="10" y2="4"/>
        <line x1="14" y1="2" x2="14" y2="4"/>
      </svg>
      <span>Third Space Cafe</span>
    </div>
    <p class="subtitle">Enter the password to access the financial tracker</p>
    <form id="loginForm">
      <input type="password" id="pwd" placeholder="Password" autofocus>
      <button type="submit">Sign In</button>
      <p class="error" id="errorMsg">Incorrect password. Please try again.</p>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwd = document.getElementById('pwd').value;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        document.getElementById('errorMsg').style.display = 'block';
        document.getElementById('pwd').value = '';
        document.getElementById('pwd').focus();
      }
    });
  </script>
</body>
</html>`;

  return new Response(loginHTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

export const config = {
  matcher: ['/', '/((?!api|_next|favicon.ico).*)'],
};
