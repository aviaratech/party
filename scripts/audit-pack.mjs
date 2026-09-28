import { execFileSync } from 'node:child_process'

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
})
const result = JSON.parse(output)[0]
if (!result || !Array.isArray(result.files)) {
  throw new Error('npm pack did not return an auditable file list')
}

const paths = result.files.map((file) => file.path).sort()
const unexpected = paths.filter(
  (path) =>
    path !== 'package.json' &&
    path !== 'README.md' &&
    path !== 'LICENSE' &&
    !path.startsWith('dist/'),
)

if (unexpected.length) {
  throw new Error(`Unexpected files in npm package: ${unexpected.join(', ')}`)
}

const required = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts']
for (const path of required) {
  if (!paths.includes(path)) throw new Error(`Required packed file is missing: ${path}`)
}

for (const requiredExport of [
  'dist/browser/lifecycle.js',
  'dist/react/index.js',
  'dist/transport/trysteroNostr.js',
]) {
  if (!paths.includes(requiredExport)) {
    throw new Error(`Required packed export is missing: ${requiredExport}`)
  }
}

console.log(`Pack audit passed: ${paths.length} files, ${result.size} bytes`)
