// Fonctions pures (testables sans navigateur)

export const PARIS_TZ = 'Europe/Paris'

const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

export const normalize = s => (s || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]/gi, '')
  .toLowerCase()

// Date du jour à Paris, sous forme { y, m, d, hour }
export const parisNow = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: PARIS_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]))
  return { y: +parts.year, m: +parts.month, d: +parts.day, hour: +parts.hour }
}

// Les 7 jours visibles sur Paris Tennis (aujourd'hui + 6), au format DD/MM/YYYY
export const planningDates = (now = new Date()) => {
  const { y, m, d } = parisNow(now)
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(Date.UTC(y, m - 1, d + i, 12))
    const dd = String(dt.getUTCDate()).padStart(2, '0')
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
    return { label: `${dd}/${mm}/${dt.getUTCFullYear()}`, weekday: dt.getUTCDay() }
  })
}

// Trouve les noms officiels correspondant aux mots-clés (ex. "mourlon")
export const matchLocations = (officialNames, keywords) => keywords.map(keyword => {
  const found = officialNames.find(name => normalize(name).includes(normalize(keyword)))
  if (!found) throw new Error(`Centre introuvable dans l'annuaire Paris Tennis : "${keyword}"`)
  return found
})

// "18h - 19h" -> 18
export const slotHour = time => {
  const match = /^(\d{1,2})\s*h/i.exec((time || '').trim())
  return match ? Number(match[1]) : null
}

// Garde les créneaux LIBRE aux heures voulues, en ignorant ceux d'aujourd'hui déjà commencés
export const filterSlots = (slots, hours, now = new Date()) => {
  const today = planningDates(now)[0].label
  const currentHour = parisNow(now).hour
  return slots.filter(slot => {
    const hour = slotHour(slot.time)
    if (slot.status !== 'LIBRE' || !hours.includes(hour)) return false
    if (slot.date === today && hour <= currentHour) return false
    return true
  })
}

export const slotKey = slot => `${slot.date}|${slot.time}|${slot.location}|${slot.court}`

// Créneaux libres maintenant qui ne l'étaient pas au passage précédent
export const newSlots = (current, previousKeys) => {
  const seen = new Set(previousKeys)
  return current.filter(slot => !seen.has(slotKey(slot)))
}

const shortName = location => {
  const n = normalize(location)
  if (n.includes('mourlon')) return 'Mourlon (15e)'
  if (n.includes('montherlant')) return 'Montherlant (16e)'
  return location
}

const dayLabel = date => {
  const [dd, mm, yyyy] = date.split('/').map(Number)
  const wd = new Date(Date.UTC(yyyy, mm - 1, dd, 12)).getUTCDay()
  return `${JOURS[wd]} ${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}`
}

// Message de notification : une ligne par créneau, triées par date puis heure
export const buildMessage = slots => {
  const sorted = [...slots].sort((a, b) => {
    const [da, ma, ya] = a.date.split('/').map(Number)
    const [db, mb, yb] = b.date.split('/').map(Number)
    return (ya - yb) || (ma - mb) || (da - db) || (slotHour(a.time) - slotHour(b.time))
      || a.location.localeCompare(b.location) || a.court.localeCompare(b.court)
  })
  const lines = sorted.map(slot => {
    const type = slot.courtType ? ` (${slot.courtType.toLowerCase()})` : ''
    return `${dayLabel(slot.date)} · ${slotHour(slot.time)}h · ${shortName(slot.location)} · ${slot.court}${type}`
  })
  const title = slots.length === 1 ? '🎾 1 créneau libre' : `🎾 ${slots.length} créneaux libres`
  return { title, message: lines.join('\n') }
}
