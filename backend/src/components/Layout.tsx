import { html } from 'hono/html'

// The tab icon is the same emoji as the logo, as an inline SVG data URI: no extra file or
// static route to serve, and it can never 404.
export const LOGO_EMOJI = '🕵️‍♂️'
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="80" text-anchor="middle" dominant-baseline="central">${LOGO_EMOJI}</text></svg>`
)}`

export const Layout = ({ children, steamId, path }: { children: any, steamId?: string, path?: string }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>TraitorDash | TTT2 Admin</title>
      <link rel="icon" href={FAVICON} />
      <script src="https://unpkg.com/htmx.org@1.9.10"></script>
      <script defer src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js"></script>
      <script defer src="/public/frontend.js"></script>
      <link href="/public/style.css" rel="stylesheet" />
    </head>
    <body class="bg-gray-900 text-white font-sans min-h-screen selection:bg-red-500/30">
      <nav class="bg-gray-800 border-b border-gray-700 px-4 py-3 sm:p-4 sticky top-0 z-50 backdrop-blur-md bg-opacity-80">
        <div class="container mx-auto flex flex-wrap justify-between items-center gap-x-4 gap-y-2">
          <a href="/" class="text-xl sm:text-2xl font-black text-red-500 hover:text-red-400 transition flex items-center gap-2">
            <span>{LOGO_EMOJI}</span> TraitorDash
          </a>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-8">
            <a href="/" class={`transition font-bold uppercase text-sm tracking-widest ${path === '/' ? 'text-red-500' : 'text-gray-400 hover:text-white'}`}>
              Dashboard
            </a>
            {steamId && (
              <div class="flex items-center gap-3 sm:gap-6">
                <a href="/servers" class={`transition font-bold uppercase text-sm tracking-widest ${path === '/servers' ? 'text-red-500' : 'text-gray-400 hover:text-white'}`}>
                  Servers
                </a>
                <div class="hidden sm:block h-4 w-px bg-gray-700"></div>
                <div class="flex items-center gap-3 bg-gray-900/50 px-3 py-1.5 rounded-full border border-gray-700 shrink-0">
                  <span class="hidden sm:inline text-xs text-gray-500 font-mono">{steamId}</span>
                  <a href="/auth/logout" class="text-red-500 hover:text-red-400 text-xs font-black uppercase">Logout</a>
                </div>
              </div>
            )}
            {!steamId && (
              <a href="/auth/steam" class="transition transform hover:scale-105">
                <img src="https://community.cloudflare.steamstatic.com/public/images/signinthroughsteam/sits_01.png" alt="Login with Steam" class="h-8" />
              </a>
            )}
          </div>
        </div>
      </nav>
      <main>
        {children}
      </main>
    </body>
  </html>
)
