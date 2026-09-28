import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packOutput = execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
})
const packed = JSON.parse(packOutput)[0]
if (!packed?.filename) throw new Error('npm pack did not return a tarball filename')

const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tarball = new URL(`../${packed.filename}`, import.meta.url)
const fixture = await mkdtemp(join(tmpdir(), 'aviaratech-party-consumer-'))

try {
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'party-consumer-check', private: true, type: 'module' }, null, 2),
  )
  execFileSync(
    'npm',
    ['install', tarball.pathname, '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: fixture, stdio: 'inherit' },
  )

  const smoke = `
import { PartyClient } from '@aviaratech/party'
import { createBrowserPartyLifecycleSource } from '@aviaratech/party/browser'
import { TrysteroNostrTransport } from '@aviaratech/party/trystero-nostr'

if (typeof PartyClient !== 'function') throw new Error('Root export did not resolve')
if (typeof createBrowserPartyLifecycleSource !== 'function') {
  throw new Error('Browser export did not resolve')
}
if (typeof TrysteroNostrTransport !== 'function') {
  throw new Error('Trystero/Nostr export did not resolve')
}

const client = new PartyClient({
  createTransport() {
    return {
      async start() {},
      async send() {},
      async sendControl() {},
      peerIds() { return [] },
      disconnectPeer() {},
      async dispose() { return { requiresReload: false } },
    }
  },
})

if (client.getSnapshot().state !== 'idle') throw new Error('Unexpected initial Party state')
await client.dispose()
`
  await writeFile(join(fixture, 'smoke.mjs'), smoke)
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: fixture, stdio: 'inherit' })
  console.log(`Packed consumer check passed for ${rootPackage.name}@${rootPackage.version}`)
} finally {
  await rm(fixture, { recursive: true, force: true })
  await rm(tarball, { force: true })
}
