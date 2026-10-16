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

export const dayLabel = date => {
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

// ---------- Lecture d'une demande (titre de ticket) ----------
// Exemples acceptés : "23/10 17h", "ven 23/10 17h-19h", "vendredi 17h", "demain 18h 19h"

const WEEKDAYS = { dim: 0, lun: 1, mar: 2, mer: 3, jeu: 4, ven: 5, sam: 6 }

const fmt = dt => `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`

export const parseRequest = (title, now = new Date()) => {
  const text = normalizeSpaces(title).toLowerCase()
  const { y, m, d } = parisNow(now)
  const today = new Date(Date.UTC(y, m - 1, d, 12))

  // Date
  let date = null
  const numeric = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/.exec(text)
  let rest = text
  if (numeric) {
    const dd = Number(numeric[1]); const mm = Number(numeric[2])
    let yyyy = numeric[3] ? Number(numeric[3]) : y
    if (yyyy < 100) yyyy += 2000
    if (!numeric[3] && mm < m - 6) yyyy += 1 // "05/01" demandé en octobre = l'an prochain
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd, 12))
    if (dt.getUTCDate() !== dd || dt.getUTCMonth() !== mm - 1) return { error: `date invalide (${numeric[0]})` }
    date = dt
    rest = text.replace(numeric[0], ' ')
  } else if (/\bdemain\b/.test(text)) {
    date = new Date(today.getTime() + 864e5)
  } else if (/\b(aujourd'?hui|auj|ce soir)\b/.test(text)) {
    date = today
  } else {
    const wd = /\b(lun|mar|mer|jeu|ven|sam|dim)[a-z]*\b/.exec(text)
    if (wd) {
      const target = WEEKDAYS[wd[1]]
      const diff = (target - today.getUTCDay() + 7) % 7
      date = new Date(today.getTime() + diff * 864e5)
    }
  }
  if (!date) return { error: 'pas de date trouvée (ex. "23/10 17h" ou "vendredi 17h")' }

  // Heures : plages "17h-19h" (= créneaux de 17h et 18h), puis heures seules "17h"
  const hours = new Set()
  rest = rest.replace(/(\d{1,2})\s*h?\s*(?:-|à|a)\s*(\d{1,2})\s*h/g, (_, a, b) => {
    for (let h = Number(a); h < Number(b); h += 1) hours.add(h)
    return ' '
  })
  for (const match of rest.matchAll(/(\d{1,2})\s*h/g)) hours.add(Number(match[1]))
  const valid = [...hours].filter(h => h >= 8 && h <= 21).sort((a, b) => a - b)
  if (valid.length === 0) return { error: 'pas d\'heure trouvée (ex. "17h" ou "17h-19h")' }

  return { date: fmt(date), hours: valid }
}

const normalizeSpaces = s => (s || '').replace(/\s+/g, ' ').trim()

// Écart en jours entre une date DD/MM/YYYY et aujourd'hui (Paris)
export const daysFromToday = (date, now = new Date()) => {
  const { y, m, d } = parisNow(now)
  const [dd, mm, yyyy] = date.split('/').map(Number)
  return Math.round((Date.UTC(yyyy, mm - 1, dd) - Date.UTC(y, m - 1, d)) / 864e5)
}

export const describeRequest = ({ date, hours }) => `${dayLabel(date)} à ${hours.map(h => `${h}h`).join(', ')}`
