import { access, readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

if (!packageJson.license || packageJson.license === 'UNLICENSED') {
  throw new Error(
    'Publishing is blocked until the owner approves a public license and package.json is updated.',
  )
}

try {
  await access(new URL('../LICENSE', import.meta.url))
} catch {
  throw new Error('Publishing is blocked until an approved LICENSE file exists.')
}

if (packageJson.private === true) {
  throw new Error('Publishing is blocked while package.json is private.')
}
