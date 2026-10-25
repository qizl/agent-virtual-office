import { isOnFloor, isOnObstacle } from './movementSystem.js'

// Keep the handoff offset away from the receiving sprite while remaining on the
// visible office floor. Both live and recorded choreography use this helper so
// the two paths cannot disagree about where a conversation takes place.
export function handoffApproachPoint(recipientSeat) {
  if (!recipientSeat || !Number.isFinite(recipientSeat.x) || !Number.isFinite(recipientSeat.y)) return null
  const candidates = [{ x: -36, y: 0 }, { x: 36, y: 0 }, { x: 0, y: 44 }, { x: -36, y: 24 }, { x: 36, y: 24 }]
  for (const delta of candidates) {
    const p = { x: recipientSeat.x + delta.x, y: recipientSeat.y + delta.y }
    if (p.x >= 24 && p.x <= 778 && p.y >= 64 && p.y <= 500 && isOnFloor(p.x, p.y) && !isOnObstacle(p.x, p.y)) return p
  }
  return null
}
