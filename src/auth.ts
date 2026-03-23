import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { URL } from 'node:url'

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
]

const AUTH_PORT = 3456

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.leo'
)
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json')
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json')

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

interface StoredCredentials {
  installed?: {
    client_id: string
    client_secret: string
    redirect_uris: string[]
  }
  web?: {
    client_id: string
    client_secret: string
    redirect_uris: string[]
  }
}

function loadCredentials(): StoredCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `No credentials found at ${CREDENTIALS_PATH}\n\n` +
        'To set up credentials:\n' +
        '1. Go to https://console.cloud.google.com/apis/credentials\n' +
        '2. Create an OAuth 2.0 Client ID (type: Desktop app)\n' +
        '3. Download the JSON and save it as:\n' +
        `   ${CREDENTIALS_PATH}\n\n` +
        'Also enable these APIs in your project:\n' +
        '  - Google Search Console API\n' +
        '  - Web Search Indexing API'
    )
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'))
}

function saveToken(token: object): void {
  ensureConfigDir()
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
}

function loadToken(): object | null {
  if (!fs.existsSync(TOKEN_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
  } catch {
    return null
  }
}

async function getAuthCodeViaLocalServer(
  authUrl: string,
  port: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      const code = url.searchParams.get('code')
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>'
        )
        server.close()
        resolve(code)
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Authorization failed</h2></body></html>')
        server.close()
        reject(new Error('No authorization code received'))
      }
    })

    server.listen(port, () => {
      console.log(`\nListening on http://localhost:${port} for OAuth callback`)
      console.log(`\nOpen this URL in your browser to authorize:\n\n${authUrl}\n`)
    })

    server.on('error', (err) => {
      reject(new Error(`Could not start local auth server on port ${port}: ${err.message}`))
    })
  })
}

export async function getAuthClient(): Promise<OAuth2Client> {
  const credentials = loadCredentials()
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web || ({} as any)

  if (!client_id || !client_secret) {
    throw new Error('Invalid credentials file - missing client_id or client_secret')
  }

  // For Desktop app credentials, Google allows any http://localhost port.
  // We always use our own redirect URI with an explicit port so we can
  // run a local server to catch the callback.
  const redirectUri = `http://localhost:${AUTH_PORT}`

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

  const token = loadToken()
  if (token) {
    oAuth2Client.setCredentials(token as any)

    // Check if token needs refresh
    const tokenInfo = oAuth2Client.credentials
    if (tokenInfo.expiry_date && tokenInfo.expiry_date < Date.now()) {
      try {
        const { credentials: refreshed } = await oAuth2Client.refreshAccessToken()
        oAuth2Client.setCredentials(refreshed)
        saveToken(refreshed)
      } catch {
        // Token refresh failed, need to re-auth
        return await authorizeInteractively(oAuth2Client)
      }
    }
    return oAuth2Client
  }

  return await authorizeInteractively(oAuth2Client)
}

async function authorizeInteractively(
  oAuth2Client: OAuth2Client
): Promise<OAuth2Client> {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    redirect_uri: `http://localhost:${AUTH_PORT}`,
  })

  const code = await getAuthCodeViaLocalServer(authUrl, AUTH_PORT)
  const { tokens } = await oAuth2Client.getToken(code)
  oAuth2Client.setCredentials(tokens)
  saveToken(tokens)
  console.log('Authentication successful! Token saved.\n')
  return oAuth2Client
}

export function getConfigDir(): string {
  return CONFIG_DIR
}
