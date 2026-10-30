// CR-15 work-seat association cache: browser-persisted member↔work-seat
// bindings keyed by [project, task], so reloading the SAME in-progress task or
// playing the same task's history keeps every role at its established desk.
// The cache stores ONLY member keys and seat coordinates — never task content,
// member snapshots or live positions; the CR-1 entrance marker keeps its own
// sessionStorage boundary and the two mechanisms never exchange data. Corrupt,
// stale or mismatched entries are ignored (CR-3 re-randomizes them); storage
// failures degrade to plain in-session allocation without ever throwing.
const CACHE_KEY = 'avo:maw-work-seats:v1'
const MAX_TASKS = 8
let writeSeq = 0 // monotonic tiebreaker — same-millisecond writes must keep LRU order
const validSeat = (seat) => seat && Number.isFinite(seat.x) && Number.isFinite(seat.y)
const seatSignature = (seat) => `${seat.x},${seat.y}`

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {} // corrupted or unavailable storage: behave like an empty cache
  }
}

function writeStore(store) {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(store))
  } catch {
    // quota/private-mode failures degrade silently: the session keeps its
    // in-memory allocation and simply does not persist it.
  }
}

/** Member-key → seat Map for one [project, task]; null when nothing usable is
 * cached. Duplicate seats inside one entry keep only the first claimant — a
 * collision is cache damage, and CR-3 re-randomizes the losers. */
export function loadWorkSeatCache(project, task) {
  const entry = readStore()[JSON.stringify([project, task])]
  if (!entry || typeof entry !== 'object' || !entry.seats || typeof entry.seats !== 'object') return null
  const seats = new Map()
  const claimed = new Set()
  for (const [memberKey, seat] of Object.entries(entry.seats)) {
    if (typeof memberKey !== 'string' || !memberKey || !validSeat(seat)) continue
    const signature = seatSignature(seat)
    if (claimed.has(signature)) continue
    claimed.add(signature)
    seats.set(memberKey, { x: seat.x, y: seat.y })
  }
  return seats.size ? seats : null
}

/** Persist one task's bindings and prune older tasks (most-recently-written
 * wins, MAX_TASKS kept) so the cache cannot grow with the task history. */
export function saveWorkSeatCache(project, task, seats) {
  if (!seats || typeof seats !== 'object' || !Object.keys(seats).length) return
  const store = readStore()
  const taskKey = JSON.stringify([project, task])
  const rank = ++writeSeq
  const fresh = {}
  for (const [key, value] of Object.entries(store)) {
    if (key !== taskKey && value && typeof value === 'object' && Number.isFinite(value.rank)) fresh[key] = value
  }
  fresh[taskKey] = { rank, seats }
  const ranked = Object.entries(fresh)
    .sort(([, a], [, b]) => b.rank - a.rank)
    .slice(0, MAX_TASKS)
  writeStore(Object.fromEntries(ranked))
}
