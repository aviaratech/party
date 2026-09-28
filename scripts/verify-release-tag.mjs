import { readFile } from 'node:fs/promises'

const tag = process.argv[2]
if (!tag) throw new Error('Expected the release tag as the first argument')

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expected = `v${packageJson.version}`
if (tag !== expected) {
  throw new Error(`Release tag ${tag} does not match package version ${expected}`)
}
