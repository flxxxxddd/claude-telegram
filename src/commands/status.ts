/**
 * `cctg status` — what the bridge is doing right now.
 */

import { db } from '../db.ts'
import { paths, projectName } from '../paths.ts'
import { queue, topics } from '../store/repos.ts'
import { ago, bad, bold, cyan, dim, heading, info, ok, pairs } from '../ui.ts'
import { askStatus } from './client.ts'

export async function status(): Promise<number> {
  const live = await askStatus()
  if (!live) {
    console.log(bad('no daemon is running'))
    console.log(info(`start one with \`cctg daemon start\`, or open a Claude Code session — the first one starts it`))
    return 1
  }

  console.log(heading(`daemon ${live.version}`))
  console.log(pairs([
    ['bot', `@${live.botUsername}`],
    ['pid', String(live.pid)],
    ['uptime', ago(live.startedAt).replace(' ago', '')],
    ['threading', live.threadMode === 'topics' ? ok('topics') : dim('flat (topic mode is off in BotFather)')],
    ['state', paths.state],
  ]))

  console.log(heading(`sessions (${live.sessions.length})`))
  if (!live.sessions.length) {
    console.log(info('none connected'))
  } else {
    for (const session of live.sessions) {
      const marks = [session.busy ? cyan('working') : dim('idle')]
      if (session.launched) marks.push(dim('launched from telegram'))
      console.log(`  ${bold(session.title)}  ${marks.join(' · ')}`)
      console.log(pairs([
        ['project', projectName(session.cwd)],
        ['path', dim(session.cwd)],
        ['model', session.model ?? dim('not reported yet')],
        ['topic', session.threadId ? String(session.threadId) : dim('none')],
        ['connected', ago(session.connectedAt)],
      ]))
    }
  }

  const conn = db()
  const known = topics.all(conn)
  if (known.length) {
    console.log(heading(`topics (${known.length})`))
    for (const topic of known) {
      const held = queue.depth(conn, topic.cwd)
      console.log(`  ${bold(topic.name)}  ${dim(topic.cwd)}${held ? cyan(`  ${held} queued`) : ''}`)
    }
  }
  return 0
}
