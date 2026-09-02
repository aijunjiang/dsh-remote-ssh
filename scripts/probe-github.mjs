/**
 * Probe how this host reaches GitHub. The harness web_fetch refuses github.com
 * because it resolves to a non-public address here, so this checks whether an
 * internal mirror answers and prints enough to plan the next step.
 */
import { lookup } from 'node:dns/promises'

for (const host of ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com']) {
  try {
    const addresses = await lookup(host, { all: true })
    console.log(host, '->', addresses.map((a) => a.address).join(', '))
  } catch (error) {
    console.log(host, '-> LOOKUP FAIL', error.message)
  }
}

for (const url of [
  'https://api.github.com/repos/Hefulalala/dsh-remote-workspace',
  'https://github.com/Hefulalala/dsh-remote-workspace',
]) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-probe' } })
    const text = await res.text()
    console.log('---', url, res.status, 'len', text.length)
    console.log(text.slice(0, 1200))
  } catch (error) {
    console.log('---', url, 'FETCH FAIL', error.message, error.cause?.message ?? '')
  }
}
