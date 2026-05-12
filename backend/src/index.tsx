import { Hono } from 'hono'
import { html } from 'hono/html'
import { serveStatic } from 'hono/bun'

const app = new Hono()

app.use('/public/*', serveStatic({ root: './src' }))

const Layout = ({ children }: { children: any }) => html`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>TraitorDash</title>
      <script defer src="/public/frontend.js"></script>
      <link href="/public/style.css" rel="stylesheet" />
    </head>
    <body class="bg-gray-900 text-white font-sans">
      ${children}
    </body>
  </html>
`

app.get('/', (c) => {
  return c.html(
    <Layout>
      <div class="container mx-auto p-8">
        <h1 class="text-4xl font-bold mb-4 text-red-500">TraitorDash 🕵️‍♂️</h1>
        <p class="text-xl text-gray-400">Dynamic Web Configuration Manager for TTT2</p>
        
        <div class="mt-8 p-6 bg-gray-800 rounded-lg shadow-xl">
          <h2 class="text-2xl font-semibold mb-2">Backend Status</h2>
          <p class="text-green-400" x-data="{ status: 'Online' }">
            System is: <span x-text="status"></span>
          </p>
          <button 
            class="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded transition"
            hx-get="/api/ping"
            hx-swap="outerHTML"
          >
            Ping Server
          </button>
        </div>
      </div>
    </Layout>
  )
})

app.get('/api/ping', (c) => {
  return c.html(
    <div class="mt-4 p-4 bg-green-900 border border-green-500 rounded">
      Pong! Server is responding via HTMX.
    </div>
  )
})

export default app
